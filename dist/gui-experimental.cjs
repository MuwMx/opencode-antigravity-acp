"use strict";Object.defineProperties(exports,{__esModule:{value:!0},[Symbol.toStringTag]:{value:"Module"}});const e=require("solid-js/web"),o=require("solid-js"),O=require("@opencode/plugin/gui"),Ie=require("@opencode/plugin/rpc"),ge={type:"object",properties:{sessionID:{type:"string"}},required:["sessionID"],additionalProperties:!1},F={type:"object",properties:{sessionID:{type:"string"},mode:{type:"string",enum:["auto","accept-edits","default","plan"]},relayAllTools:{type:"boolean"},acpSessionId:{anyOf:[{type:"string"},{type:"null"}]},connected:{type:"boolean"},busy:{type:"boolean"},modelCount:{type:"number"},relayedToolCount:{type:"number"},lastError:{anyOf:[{type:"string"},{type:"null"}]},cooldownUntil:{anyOf:[{type:"number"},{type:"null"}]}},required:["sessionID","mode","relayAllTools","acpSessionId","connected","busy","modelCount","relayedToolCount","lastError","cooldownUntil"],additionalProperties:!1},Re=Ie.Rpc.define({id:"antigravity-acp",methods:{getState:{input:ge,output:F},setMode:{input:{type:"object",properties:{sessionID:{type:"string"},mode:{type:"string",enum:["auto","accept-edits","default","plan"]}},required:["sessionID","mode"],additionalProperties:!1},output:F},setRelayAll:{input:{type:"object",properties:{sessionID:{type:"string"},relayAllTools:{type:"boolean"}},required:["sessionID","relayAllTools"],additionalProperties:!1},output:F},resetSession:{input:ge,output:F},reloadModels:{input:{type:"object",properties:{},additionalProperties:!1},output:{type:"object",properties:{modelCount:{type:"number"}},required:["modelCount"],additionalProperties:!1}}},events:{}});var Te=e.template("<span class=agy-chip> tools"),ze=e.template("<div class=agy-pop><div class=agy-status><div class=agy-status-main><span class=agy-dot aria-hidden=true></span><span class=agy-status-text></span></div><div class=agy-meta-chips></div></div><div class=agy-sec><div class=agy-sec-head><span class=agy-sec-title>Approval mode</span></div><div role=group class=agy-mode-grid></div><p class=agy-hint></p></div><div class=agy-sec><div class=agy-sec-head><span class=agy-sec-title>Tool bridge</span><span class=agy-sec-badge></span></div><div role=group class=agy-bridge-seg><button type=button class=agy-bridge-btn><span>Native + MCP</span></button><button type=button class=agy-bridge-btn><span>All OpenCode</span></button></div><p class=agy-hint></p></div><div class=agy-actions>"),Oe=e.template("<span class=agy-chip>No thread"),De=e.template('<span class="agy-chip agy-mono">#'),je=e.template("<div role=alert class=agy-alert><span class=agy-alert-icon aria-hidden=true></span><span class=agy-alert-body>"),qe=e.template("<span class=agy-check-icon aria-hidden=true>"),Fe=e.template("<button type=button class=agy-seg-btn><span>");const Ue="antigravity-acp",pe=1e4,U={auto:"Auto","accept-edits":"Accept edits",default:"Ask",plan:"Plan"},W=[{id:"auto",label:"Auto",detail:"Approves edits and shell commands automatically."},{id:"accept-edits",label:"Accept edits",detail:"Approves file edits; prompts before shell commands."},{id:"default",label:"Ask",detail:"Prompts before file edits and shell commands."},{id:"plan",label:"Plan",detail:"Creates a plan before executing changes."}];function B(r){if(r instanceof Error)return r.message;if(typeof r=="string")return r;try{const b=JSON.stringify(r);return b===void 0?String(r):b}catch{return String(r)}}const Be=`
.agy-pop {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 4px 4px;
  box-sizing: border-box;
  color: var(--v2-text-text-base, #fafafa);
  font-family: var(--v2-font-family-sans, ui-sans-serif, system-ui, -apple-system, sans-serif);
  font-size: 13px;
  line-height: 18px;
  letter-spacing: -0.04px;
  font-variant-numeric: tabular-nums;
}

.agy-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--v2-background-bg-base, #161616);
  border: 0.5px solid var(--v2-border-border-muted, rgba(255, 255, 255, 0.08));
}

.agy-status-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.agy-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--v2-text-text-faint, #777777);
}
.agy-dot[data-state="connected"] { background: var(--v2-state-fg-success, #4ade80); }
.agy-dot[data-state="busy"] {
  background: var(--v2-state-fg-info, #60a5fa);
  animation: agy-pulse 1.5s ease-in-out infinite;
}
.agy-dot[data-state="cooldown"] { background: var(--v2-state-fg-warning, #f59e0b); }
.agy-dot[data-state="error"] { background: var(--v2-state-fg-danger, #f87171); }

@keyframes agy-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.42; }
}
:root[data-motion="reduce"] .agy-dot[data-state="busy"] { animation: none; }
@media (prefers-reduced-motion: reduce) {
  .agy-dot[data-state="busy"] { animation: none; }
}

.agy-status-text {
  font-size: 12.5px;
  font-weight: 530;
  color: var(--v2-text-text-base, #fafafa);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agy-meta-chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.agy-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--v2-background-bg-layer-02, #2e2e2e);
  color: var(--v2-text-text-muted, #aeaeae);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.agy-mono {
  font-family: var(--v2-font-family-mono, ui-monospace, SFMono-Regular, monospace);
}

.agy-alert {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 16px;
  word-break: break-word;
  border: 0.5px solid var(--v2-state-border-danger, rgba(248, 113, 113, 0.3));
  background: var(--v2-state-bg-danger, rgba(127, 29, 29, 0.35));
  color: var(--v2-state-fg-danger, #fca5a5);
}
.agy-alert[data-tone="warning"] {
  border-color: var(--v2-state-border-warning, rgba(245, 158, 11, 0.35));
  background: var(--v2-state-bg-warning, rgba(120, 53, 15, 0.35));
  color: var(--v2-state-fg-warning, #fcd34d);
}
.agy-alert-icon {
  flex-shrink: 0;
  margin-top: 1px;
}
.agy-alert-body {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.agy-sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agy-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agy-sec-title {
  font-size: 11px;
  font-weight: 530;
  line-height: 15px;
  color: var(--v2-text-text-faint, #888888);
  user-select: none;
}

.agy-sec-badge {
  font-size: 11px;
  font-weight: 500;
  line-height: 15px;
  color: var(--v2-text-text-muted, #aeaeae);
}

.agy-mode-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.agy-seg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-block-size: 30px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 0.5px solid var(--v2-border-border-muted, rgba(255, 255, 255, 0.08));
  background: var(--v2-background-bg-base, #161616);
  color: var(--v2-text-text-muted, #aeaeae);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 480;
  line-height: 16px;
  text-align: left;
  cursor: pointer;
  transition: background-color 100ms ease, border-color 100ms ease, color 100ms ease;
}
.agy-seg-btn:hover:not(:disabled, [aria-pressed="true"]) {
  background: var(--v2-overlay-simple-overlay-hover, rgba(255, 255, 255, 0.06));
  color: var(--v2-text-text-base, #fafafa);
}
.agy-seg-btn[aria-pressed="true"] {
  background: var(--v2-background-bg-layer-02, #2e2e2e);
  border-color: var(--v2-border-border-strong, rgba(255, 255, 255, 0.2));
  color: var(--v2-text-text-base, #fafafa);
  font-weight: 540;
}
.agy-seg-btn[aria-pressed="true"] .agy-check-icon {
  color: var(--v2-state-fg-success, #4ade80);
}
.agy-seg-btn:focus-visible {
  outline: 2px solid var(--v2-border-border-focus, #3b82f6);
  outline-offset: 1px;
}
.agy-seg-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.agy-bridge-seg {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: 7px;
  background: var(--v2-background-bg-base, #161616);
  border: 0.5px solid var(--v2-border-border-muted, rgba(255, 255, 255, 0.08));
}

.agy-bridge-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-block-size: 28px;
  padding: 4px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--v2-text-text-muted, #aeaeae);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease;
}
.agy-bridge-btn:hover:not(:disabled, [aria-pressed="true"]) {
  background: var(--v2-overlay-simple-overlay-hover, rgba(255, 255, 255, 0.06));
  color: var(--v2-text-text-base, #fafafa);
}
.agy-bridge-btn[aria-pressed="true"] {
  background: var(--v2-background-bg-layer-02, #2e2e2e);
  color: var(--v2-text-text-base, #fafafa);
  box-shadow: var(--v2-elevation-elements, inset 0 0 0 0.5px rgba(255, 255, 255, 0.14));
  font-weight: 540;
}
.agy-bridge-btn:focus-visible {
  outline: 2px solid var(--v2-border-border-focus, #3b82f6);
  outline-offset: 1px;
}
.agy-bridge-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.agy-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 15px;
  color: var(--v2-text-text-muted, #9a9a9a);
}

.agy-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  padding-top: 8px;
  border-top: 0.5px solid var(--v2-border-border-muted, rgba(255, 255, 255, 0.08));
}

.agy-action-btn {
  width: 100%;
  min-width: 0;
  justify-content: center;
}
`,Le=O.Plugin.define({setup(r){r.add(O.Style,Be);const b=()=>r.client.rpc(Re),L=new Map,D=new Set,E=new Set,I=new Map,N=t=>{let i=L.get(t);return i||(i=o.createSignal(void 0),L.set(t,i)),i},A=t=>({...t?{location:{directory:t}}:{},signal:r.signal}),R=(t,i)=>{const[,u]=N(t);D.add(t),I.delete(t),u(i)},j=(t,i,u=!1)=>{if(!(!t||r.signal.aborted)){if(!u){if(D.has(t)||E.has(t))return;const m=I.get(t);if(m!==void 0&&Date.now()-m<pe)return}E.add(t),b().getState({sessionID:t},A(i)).then(m=>{r.signal.aborted||R(t,m)}).catch(()=>{I.set(t,Date.now())}).finally(()=>{E.delete(t)})}},be=(t,i)=>{if(!t||D.has(t)||E.has(t))return;const u=I.get(t);u!==void 0&&Date.now()-u<pe||queueMicrotask(()=>{o.untrack(()=>j(t,i,!1))})};function fe(t){const i=o.createUniqueId(),[u,m]=o.createSignal(null),[S,h]=o.createSignal(!1),[x,q]=o.createSignal(!1),[f,w]=o.createSignal(!1),[ye,C]=o.createSignal(null),[ve,Y]=o.createSignal(Date.now()),_=()=>t.session.id,T=()=>t.session.directory,g=()=>o.untrack(()=>N(_()))[0]();o.createEffect(()=>{const a=_(),s=T();o.untrack(()=>j(a,s,!0))}),o.createEffect(()=>{const a=g()?.cooldownUntil;if(!a||a<=Date.now())return;Y(Date.now());const s=setInterval(()=>{const l=Date.now();Y(l),l>=a&&clearInterval(s)},1e3);o.onCleanup(()=>clearInterval(s))});const H=()=>g()?.mode??"auto",P=()=>g()?.relayAllTools??!1,me=()=>W.find(a=>a.id===H())??W[0],J=()=>{const a=g()?.cooldownUntil;if(!a)return 0;const s=a-ve();return s>0?Math.ceil(s/1e3):0},he=()=>{const a=g();return a?.busy?"busy":J()>0?"cooldown":a?.lastError?"error":a?.connected?"connected":"idle"},xe=()=>{const a=g();if(a?.busy)return"Running";const s=J();return s>0?`Cooldown · ${s}s`:a?.lastError?"Error":a?.connected?"Connected":"Standby"},we=()=>{const a=ye();if(a)return{tone:"danger",text:a};const s=J(),l=g();if(s>0)return{tone:"warning",text:`Circuit breaker paused requests for ${s}s after upstream API error${l?.lastError?`: ${l.lastError}`:"."}`};if(l?.lastError)return{tone:"danger",text:l.lastError}},Ce=()=>{const a=g();return a?a.relayAllTools?a.relayedToolCount>0?`All (${a.relayedToolCount})`:"All tools":a.relayedToolCount>0?`${a.relayedToolCount} bridged`:"MCP + Skills":"MCP + Skills"},Ae=async a=>{if(u()!==null||H()===a)return;const s=_(),l=T();C(null),m(a);try{const y=await b().setMode({sessionID:s,mode:a},A(l));R(s,y)}catch(y){C(B(y))}finally{m(null)}},Z=async a=>{if(S()||P()===a)return;const s=_(),l=T();C(null),h(!0);try{const y=await b().setRelayAll({sessionID:s,relayAllTools:a},A(l));R(s,y),r.toast.show({title:"Tool bridge updated",description:a?"Routing all OpenCode tools (incl. read/edit/bash)":"Using ACP native file/shell + bridged MCP & skills",variant:"success"})}catch(y){C(B(y))}finally{h(!1)}},Se=async()=>{if(x()||f())return;const a=_(),s=T();C(null),q(!0);try{const l=await b().resetSession({sessionID:a},A(s));R(a,l),r.toast.show({title:"Antigravity ACP thread reset",variant:"success"})}catch(l){C(B(l))}finally{q(!1)}},ke=async()=>{if(f()||x())return;const a=_(),s=T();C(null),w(!0);try{const l=await b().reloadModels({},A(s));j(a,s,!0),r.toast.show({title:"Antigravity models refreshed",description:`${l.modelCount} models available`,variant:"success"})}catch(l){C(B(l))}finally{w(!1)}},ee=`${i}-mode`,te=`${i}-mode-hint`,ae=`${i}-bridge`,K=`${i}-bridge-hint`;return(()=>{var a=ze(),s=a.firstChild,l=s.firstChild,y=l.firstChild,$e=y.nextSibling,re=l.nextSibling,V=s.nextSibling,ne=V.firstChild,_e=ne.firstChild,G=ne.nextSibling,se=G.nextSibling,oe=V.nextSibling,ie=oe.firstChild,le=ie.firstChild,Pe=le.nextSibling,Q=ie.nextSibling,k=Q.firstChild,Me=k.firstChild,M=k.nextSibling,Ee=M.firstChild,de=Q.nextSibling,ce=oe.nextSibling;return e.insert($e,xe),e.insert(re,e.createComponent(o.Show,{get when(){return g()?.acpSessionId},get fallback(){return Oe()},children:n=>(()=>{var d=De();return d.firstChild,e.insert(d,()=>n().slice(0,8),null),e.effect(()=>e.setAttribute(d,"title",`ACP thread ${n()}`)),d})()}),null),e.insert(re,e.createComponent(o.Show,{get when(){return(g()?.relayedToolCount??0)>0},get children(){var n=Te(),d=n.firstChild;return e.insert(n,()=>g().relayedToolCount,d),n}}),null),e.insert(a,e.createComponent(o.Show,{get when(){return we()},children:n=>(()=>{var d=je(),$=d.firstChild,p=$.nextSibling;return e.insert($,e.createComponent(r.ui.Icon,{get name(){return n().tone==="warning"?"warning":"circle-exclamation"},size:"small"})),e.insert(p,()=>n().text),e.effect(v=>{var c=n().tone,z=n().text;return c!==v.e&&e.setAttribute(d,"data-tone",v.e=c),z!==v.t&&e.setAttribute(d,"title",v.t=z),v},{e:void 0,t:void 0}),d})()}),V),e.setAttribute(_e,"id",ee),e.setAttribute(G,"aria-labelledby",ee),e.insert(G,e.createComponent(o.For,{each:W,children:n=>{const d=()=>H()===n.id,$=()=>u()===n.id;return(()=>{var p=Fe(),v=p.firstChild;return p.$$click=()=>{Ae(n.id)},e.setAttribute(p,"aria-describedby",te),e.insert(v,()=>n.label),e.insert(p,e.createComponent(o.Show,{get when(){return!$()},get fallback(){return e.createComponent(r.ui.Loader,{size:"small"})},get children(){return e.createComponent(o.Show,{get when(){return d()},get children(){var c=qe();return e.insert(c,e.createComponent(r.ui.Icon,{name:"check-small",size:"small"})),c}})}}),null),e.effect(c=>{var z=d(),ue=u()!==null;return z!==c.e&&e.setAttribute(p,"aria-pressed",c.e=z),ue!==c.t&&(p.disabled=c.t=ue),c},{e:void 0,t:void 0}),p})()}})),e.setAttribute(se,"id",te),e.insert(se,()=>me().detail),e.setAttribute(le,"id",ae),e.insert(Pe,Ce),e.setAttribute(Q,"aria-labelledby",ae),k.$$click=()=>{Z(!1)},e.setAttribute(k,"aria-describedby",K),e.insert(k,e.createComponent(o.Show,{get when(){return e.memo(()=>!!S())()&&P()},get children(){return e.createComponent(r.ui.Loader,{size:"small"})}}),Me),M.$$click=()=>{Z(!0)},e.setAttribute(M,"aria-describedby",K),e.insert(M,e.createComponent(o.Show,{get when(){return e.memo(()=>!!S())()&&!P()},get children(){return e.createComponent(r.ui.Loader,{size:"small"})}}),Ee),e.setAttribute(de,"id",K),e.insert(de,()=>P()?"Routes read, edit, bash, Code Mode, MCP & skills through OpenCode (resets thread on switch).":"ACP runs native file & shell; OpenCode bridges Code Mode, MCP & skills."),e.insert(ce,e.createComponent(r.ui.Button,{size:"small",variant:"neutral",icon:"reset",get busy(){return x()},get disabled(){return f()},class:"agy-action-btn",onClick:()=>{Se()},children:"Reset thread"}),null),e.insert(ce,e.createComponent(r.ui.Button,{size:"small",variant:"neutral",icon:"refresh",get busy(){return f()},get disabled(){return x()},class:"agy-action-btn",onClick:()=>{ke()},get children(){return`Models (${g()?.modelCount??9})`}}),null),e.effect(n=>{var d=he(),$=!P(),p=S(),v=P(),c=S();return d!==n.e&&e.setAttribute(y,"data-state",n.e=d),$!==n.t&&e.setAttribute(k,"aria-pressed",n.t=$),p!==n.a&&(k.disabled=n.a=p),v!==n.o&&e.setAttribute(M,"aria-pressed",n.o=v),c!==n.i&&(M.disabled=n.i=c),n},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0}),a})()}r.add(O.ComposerPill,{id:"controls",order:-10,show(t){if(t.screen.composer.model()?.providerID!==Ue)return;const u=t.session.id,m=t.session.directory,[S]=o.untrack(()=>N(u));be(u,m);const h=S(),x=h?.mode??"auto",q=!!(h?.cooldownUntil&&h.cooldownUntil>Date.now());let f=`ACP · ${U[x]}`,w;return h?.busy?(f=`ACP · ${U[x]} · Running`,w="success"):q?(f="ACP · Cooldown",w="warning"):h?.lastError?(f=`ACP · ${U[x]} · Error`,w="danger"):h?.connected&&(f=`ACP · ${U[x]} · Connected`,w="success"),{icon:"brain",label:f,title:"Antigravity ACP",tone:w}},menu:t=>fe(t)});const X=()=>{const t=r.sessions.current();if(!t)return;const i=t.directory??t.location?.directory;return{sessionID:t.id,directory:i}};return r.add(O.Command,()=>({id:"reset",title:"Antigravity ACP: Reset Session",section:"session",slash:{name:"agy-reset"},run:async()=>{const t=X();if(!t)return;const i=await b().resetSession({sessionID:t.sessionID},A(t.directory));R(t.sessionID,i),r.toast.show({title:"Antigravity ACP thread reset",variant:"success"})}})),r.add(O.Command,()=>({id:"reload",title:"Antigravity ACP: Reload Models",section:"model",slash:{name:"agy-reload"},run:async()=>{const t=X(),i=await b().reloadModels({},A(t?.directory));t&&j(t.sessionID,t.directory,!0),r.toast.show({title:"Antigravity models refreshed",description:`${i.modelCount} models available`,variant:"success"})}})),()=>{L.clear(),D.clear(),E.clear(),I.clear()}}});e.delegateEvents(["click"]);exports.default=Le;
