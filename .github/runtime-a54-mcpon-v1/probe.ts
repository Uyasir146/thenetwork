/** Public synthetic ONLY; actual retained image normal MCP wiring; no OAuth/grant/OTP calls. */
import {signProxyHeaders} from '/app/packages/platform/src/proxy.ts';
import {NETWORK_FRESH_PERSON_SITES} from '/app/packages/core/src/svc/network-delegation.ts';
const deadline=Number(process.env.QUALIFY_DEADLINE_MS);const checks:{label:string;pass:boolean}[]=[];
function guard(){if(!Number.isFinite(deadline)||Date.now()>=deadline)throw Error('finite MCP qualification deadline');}
function check(ok:unknown,label:string){checks.push({label,pass:!!ok});if(!ok)throw Error(label);}
async function request(origin:string,path:string,body?:unknown,bearer?:string){guard();const method=body===undefined?'GET':'POST';const headers=new Headers(await signProxyHeaders('synthetic-proxy-'.repeat(4),{host:new URL(origin).host,ip:'198.51.100.20',method,path}));headers.set('origin',origin);if(body!==undefined){headers.set('content-type','application/json');headers.set('mcp-protocol-version','2025-03-26');}if(bearer)headers.set('authorization','Bearer '+bearer);return fetch('http://127.0.0.1:8790'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(2000,deadline-Date.now())))});}
const rpc=(method:string,params:unknown={})=>({jsonrpc:'2.0',id:1,method,params});
const init=rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'public-config-probe',version:'1'}});
const protectedCall=rpc('tools/call',{name:'check_status',arguments:{}});
let healthy=false;const readyDeadline=Math.min(deadline,Date.now()+20000);while(Date.now()<readyDeadline){guard();try{healthy=(await fetch('http://127.0.0.1:8790/healthz',{signal:AbortSignal.timeout(1000)})).status===200;}catch{}if(healthy)break;await Bun.sleep(100);}
check(healthy,'readiness only');
const build=await fetch('http://127.0.0.1:8790/healthz',{signal:AbortSignal.timeout(1000)});check(build.headers.get('x-network-build')==='a54d85c9aca1654ddefaf9313b9f3a9a446fe1ae','exact merged BUILD_ID');
for(const[app,origin]of Object.entries(NETWORK_FRESH_PERSON_SITES)){
 const discovery=await request(origin,'/.well-known/oauth-authorization-server');const d=await discovery.json()as any;check(discovery.status===200&&d.issuer===origin&&d.authorization_endpoint===origin+'/oauth/authorize'&&d.token_endpoint===origin+'/oauth/token'&&d.registration_endpoint===origin+'/oauth/register'&&d.code_challenge_methods_supported.includes('S256'),app+' actual MCP issuer');
 const resource=await request(origin,'/.well-known/oauth-protected-resource/mcp');const r=await resource.json()as any;check(resource.status===200&&r.resource===origin+'/mcp'&&r.authorization_servers.includes(origin),app+' protected resource');
 const initialized=await request(origin,'/mcp',init);const i=await initialized.json()as any;check(initialized.status===200&&i.result?.serverInfo&&i.result.protocolVersion==='2025-03-26',app+' actual MCP initialize');
 const listed=await request(origin,'/mcp',rpc('tools/list'));const l=await listed.json()as any;check(listed.status===200&&Array.isArray(l.result?.tools)&&l.result.tools.some((x:any)=>x.name==='check_status'),app+' public MCP tool definitions');
 const denied=await request(origin,'/mcp',protectedCall);check(denied.status===401&&(denied.headers.get('www-authenticate')??'').includes(origin+'/.well-known/oauth-protected-resource/mcp'),app+' no grant protected denial');
 const invalid=await request(origin,'/mcp',rpc('tools/list'),'synthetic-invalid');check(invalid.status===401&&(invalid.headers.get('www-authenticate')??'').includes('invalid_token'),app+' invalid bearer refused');
 const open=await request(origin,'/mcp/openai',init);if(app==='slop'){check(open.status===404,'Slop OpenAI remains off');}else{
  const o=await open.json()as any;check(open.status===200&&o.result?.serverInfo,app+' OpenAI initialize');const access=await request(origin,'/mcp/openai',protectedCall);const a=await access.json()as any;check(access.status===200&&a.result?.isError===true&&a.result._meta?.['mcp/www_authenticate']?.[0]?.includes(origin+'/.well-known/oauth-protected-resource/mcp/openai'),app+' OpenAI protected tool challenge');
 }
}
guard();const unsigned=await fetch('http://127.0.0.1:8790/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(init),signal:AbortSignal.timeout(2000)});check(unsigned.status===421,'unsigned MCP edge refused');
console.log(JSON.stringify({state:'ACTUAL_EB_IMAGE_MCP_ENABLED_PUBLIC_CONFIG_GAP_PASS_NOT_AUTH_ACCEPTANCE',checks,realKeys:0,grants:0,OTP:0,providerCalls:0,signup:0}));
