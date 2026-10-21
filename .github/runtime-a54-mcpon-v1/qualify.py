"""One exact retained-image boot on a disposable hosted runner; no rebuild or live data."""
from pathlib import Path
from oci_to_docker import convert
import hashlib,json,os,re,subprocess,threading,time,datetime
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'receipts';CONTROL=ROOT/'control'
CONFIG='sha256:0339cf63e35a73a492a1b3795ddad82614c0acff240b442e3b3261f03dcec184'
PG='postgres@sha256:75adc2a65806c96bc0e59030230bfe3f1c1b0d6d8f8181a8913e2b8b53bdc166'
WORK_SECONDS=480;OBSERVE_SECONDS=600;MAX_RECEIPTS=8388608;COMMAND_CAPTURE=65536
# Default closed BEFORE any Docker/controller operation. New published Root review required.
grant=json.loads((ROOT/'ROOT-GRANT.json').read_text())
assert grant['executionApproved']is True and grant['rootReviewed']is True and grant['phase']=='hosted-a54-mcp-enabled-retained-image-v1-only'
assert grant['notBefore']<=time.time()<grant['expiresAt']and 0<grant['expiresAt']-grant['notBefore']<=1200
assert grant['source']=='a54d85c9aca1654ddefaf9313b9f3a9a446fe1ae'and grant['imageConfig']==CONFIG
assert grant['publicSyntheticOnly']is True and grant['ownedGracefulAppTermOncePermitted']is True and grant['ownedPGSmartStopOncePermitted']is True
assert all(grant[k]is False for k in ['realKeysPermitted','existingDBPermitted','providerPermitted','OTPOrGrantPermitted','imageRebuildPermitted'])
assert hashlib.sha256((ROOT/'PINS.json').read_bytes()).hexdigest()==grant['pinsSHA256']
for name,pin in json.loads((ROOT/'PINS.json').read_text()).items():
 raw=(ROOT/name).read_bytes();assert len(raw)==pin['bytes']and hashlib.sha256(raw).hexdigest()==pin['sha256']
OUT.mkdir(exist_ok=False);CONTROL.mkdir(exist_ok=False)
started=time.monotonic();work_end=min(started+WORK_SECONDS,started+grant['expiresAt']-time.time());observe_end=min(started+OBSERVE_SECONDS,started+grant['expiresAt']-time.time())
seq=0;written=0;unknown=False;containers={};clients=[];stops=set()
ENV={k:os.environ[k] for k in ['PATH','HOME'] if k in os.environ}
def save(name,value,final=False):
    global written
    data=(json.dumps(value,ensure_ascii=True,separators=(',',':'))+'\n').encode()
    assert len(data)<=1048576,'PER_RECEIPT_1MIB'
    assert written+len(data)<=MAX_RECEIPTS-(0 if final else 1048576),'FINAL_RECEIPT_RESERVE'
    with (OUT/name).open('xb') as f:f.write(data)
    written+=len(data)
def birth(pid):return (Path('/proc')/str(pid)/'stat').read_text().rsplit(') ',1)[1].split()[19]
def run(args,limit=20,allowed=(0,),cleanup=False,capture_limit=None):
    global seq,unknown
    assert not unknown,'UNKNOWN_CLIENT_NO_NEW_COMMAND'
    end_limit=observe_end if cleanup else work_end
    assert time.monotonic()<end_limit,'NO_NEW_STAGE_AFTER_DEADLINE'
    seq+=1;capture=min(COMMAND_CAPTURE if capture_limit is None else min(COMMAND_CAPTURE,capture_limit),max(0,(MAX_RECEIPTS-written-2097152)//6))
    assert capture>=1024,'COMMAND_CAPTURE_BUDGET'
    p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV)
    record={'argv':args,'pid':p.pid,'started':time.time(),'reaped':False,'signals':0,'retries':0,'captureCombinedBytes':capture}
    try:record['birth']=birth(p.pid)
    except FileNotFoundError:record['birth']=None
    clients.append(record);lock=threading.Lock();buf=[bytearray(),bytearray()];counts=[0,0];retained=[0]
    def drain(stream,i):
        try:
            while True:
                chunk=stream.read(65536)
                if not chunk:break
                with lock:
                    counts[i]+=len(chunk);keep=min(len(chunk),max(0,capture-retained[0]));buf[i].extend(chunk[:keep]);retained[0]+=keep
        except OSError as e:record['drainError']=type(e).__name__
        finally:stream.close()
    threads=[threading.Thread(target=drain,args=(s,i),daemon=True) for i,s in enumerate([p.stdout,p.stderr])]
    for t in threads:t.start()
    deadline=min(end_limit,time.monotonic()+limit)
    while p.poll() is None and time.monotonic()<deadline:time.sleep(.05)
    if p.poll() is not None:
        p.wait()
        for t in threads:t.join(max(0,deadline-time.monotonic()))
    complete=p.returncode is not None and not any(t.is_alive() for t in threads)
    with lock:
        record.update(returncode=p.returncode,reaped=complete,bytes=list(counts),retainedBytes=[len(x) for x in buf],truncated=sum(counts)>retained[0],stdout=bytes(buf[0]).decode('utf8','replace'),stderr=bytes(buf[1]).decode('utf8','replace'),deadlineExceeded=not complete)
    save(f'command-{seq:03}.json',record)
    if not complete:
        unknown=True
        raise RuntimeError('CLIENT_DEADLINE_UNKNOWN_NO_KILL_NO_RETRY')
    assert not record.get('drainError') and not record['truncated'],'BOUNDED_OUTPUT_EXCEEDED'
    assert p.returncode in allowed,'COMMAND_FAILED_'+str(seq)
    return bytes(buf[0]),p.returncode

def inspect(cid,cleanup=False):return json.loads(run(['docker','inspect',cid],cleanup=cleanup)[0])[0]
def kernel_witness(name,row):
    spec=containers[name];pid=row['State']['Pid'];assert row['State']['Running'] and pid>0 and row['Id']==spec['cid'] and row['Image']==spec['image']
    born=birth(pid);assert not spec.get('birth') or (spec['pid']==pid and spec['birth']==born),'PID_BIRTH_DRIFT'
    cgtext=(Path('/proc')/str(pid)/'cgroup').read_text();parts=[x.split('::',1)[1] for x in cgtext.splitlines() if '::' in x];assert len(parts)==1 and '..'not in parts[0].split('/')
    cg=Path('/sys/fs/cgroup')/parts[0].lstrip('/');assert cg.exists();values={k:(cg/k).read_text().strip() for k in ['cpu.max','memory.max','memory.swap.max','pids.max','memory.events','memory.peak']}
    quota,period=values['cpu.max'].split();assert int(quota)*100000==spec['cpuQuota']*int(period),'ACTUAL_CPU_CAP';assert values['memory.max']==str(spec['memory']) and values['memory.swap.max']=='0' and values['pids.max']=='128','ACTUAL_MEMORY_SWAP_PID_CAP'
    events={k:int(v) for k,v in (line.split() for line in values['memory.events'].splitlines())};assert all(events.get(k,0)==0 for k in ['oom','oom_kill','oom_group_kill']),'ACTUAL_NO_OOM'
    spec.update(pid=pid,birth=born,cgroup=str(cg),lastKernel=values)
    save(f'kernel-{name}-{seq:03}.json',{'container':row['Id'],'created':row['Created'],'image':row['Image'],'pid':pid,'birth':born,'cgroup':str(cg),'kernel':values})
    return row

def start(name,image,env=None,args=None):
    mem=536870912 if name=='pg' else 1610612736;cpu=50000 if name=='pg' else 100000
    cmd=['docker','create','--name','network-a54-mcpon-v1-'+name,'--network','none' if name=='pg' else 'container:'+containers['pg']['cid'],'--cpus','.5' if name=='pg' else '1','--memory',str(mem),'--memory-swap',str(mem),'--pids-limit','128','--log-driver','local','--log-opt','max-size=256k','--log-opt','max-file=1','--log-opt','compress=false']
    if name=='pg':cmd+=['--tmpfs','/var/lib/postgresql/data:rw,size=512m','--tmpfs','/var/run/postgresql:rw,size=8m']
    else:cmd+=['--read-only','--tmpfs','/tmp:rw,size=64m','--mount','type=bind,src='+str(ROOT)+',dst=/qualification,readonly','--mount','type=bind,src='+str(CONTROL)+',dst=/control,readonly']
    for k,v in (env or {}).items():cmd+=['--env',k+'='+v]
    cmd+=[image]+(args or []);cid=run(cmd)[0].decode().strip();assert re.fullmatch('[0-9a-f]{64}',cid)
    containers[name]={'cid':cid,'image':image,'memory':mem,'cpuQuota':cpu}
    created=inspect(cid)
    assert created['Id']==cid and created['Image']==image and created['Name']=='/network-a54-mcpon-v1-'+name,'EXACT_CREATED_CONTAINER_IDENTITY'
    containers[name].update(created=created['Created'],name=created['Name'])
    save('created-'+name+'.json',{'Id':cid,'Image':image,'Created':created['Created'],'Name':created['Name'],'State':created['State'],'HostConfig':{k:created['HostConfig'].get(k) for k in ['NanoCpus','Memory','MemorySwap','PidsLimit','LogConfig','NetworkMode','ReadonlyRootfs']}})
    run(['docker','start',cid]);row=inspect(cid);kernel_witness(name,row);return cid

def wait_exit(name,seconds,cleanup=False):
    cid=containers[name]['cid'];end=min(observe_end if cleanup else work_end,time.monotonic()+seconds)
    while time.monotonic()<end:
        row=inspect(cid,cleanup=cleanup)
        if not row['State']['Running']:
            assert row['State']['Pid']==0 and not row['State']['OOMKilled'] and row['State']['ExitCode']==0,'EXIT_OR_OOM_FAILURE'
            save('terminal-'+name+'.json',row);containers[name]['terminal']=True;return row
        kernel_witness(name,row);time.sleep(.25)
    raise RuntimeError('CONTAINER_SURVIVOR_NO_FORCED_STOP')

def capture_owned_failure_evidence():
    evidence={'state':'READ_ONLY_FAILURE_EVIDENCE','containers':[],'skipped':None}
    if unknown or time.monotonic()>=observe_end:
        evidence['skipped']='UNKNOWN_CLIENT_OR_OBSERVER_EXPIRED';return evidence
    for name,spec in list(containers.items()):
        if unknown or time.monotonic()>=observe_end or MAX_RECEIPTS-written<2097152:
            evidence['skipped']='UNKNOWN_DEADLINE_OR_RECEIPT_BUDGET';break
        item={'name':name,'container':spec['cid'],'expectedImage':spec['image']};evidence['containers'].append(item)
        try:
            raw,_=run(['docker','inspect',spec['cid']],limit=4,cleanup=True,capture_limit=16384)
            item['inspectCommandReceipt']='command-%03d.json'%seq
            row=json.loads(raw)[0]
            assert row['Id']==spec['cid'] and row['Image']==spec['image'],'FAILURE_INSPECT_EXACT_ID_IMAGE'
            assert not spec.get('created') or row['Created']==spec['created'],'FAILURE_INSPECT_CREATED'
            assert not spec.get('name') or row['Name']==spec['name'],'FAILURE_INSPECT_NAME'
            item.update(identityVerified=True,created=row['Created'],actualState=row['State'])
        except BaseException as error:
            item['inspectError']=type(error).__name__+':'+str(error)[:256];continue
        if unknown or time.monotonic()>=observe_end:
            item['logsSkipped']='UNKNOWN_CLIENT_OR_OBSERVER_EXPIRED';break
        try:
            item['logsCommandReceipt']='command-%03d.json'%(seq+1)
            run(['docker','logs','--tail','80','--timestamps',spec['cid']],limit=4,allowed=(0,1),cleanup=True,capture_limit=16384)
        except BaseException as error:
            # run() persisted byte counts, bounded stdout/stderr and truncation before raising.
            item['logsError']=type(error).__name__+':'+str(error)[:256]
    return evidence

outcome={'passed':False,'productionActions':0,'realData':0,'providerCalls':0,'controllerWorkSeconds':WORK_SECONDS,'controllerObservationSeconds':OBSERVE_SECONDS,'runnerTimeoutMinutes':20}
try:
    archive=ROOT/'artifact/backend.oci.tar';assert archive.stat().st_size==75390976
    with archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()=='00667c88094549ac7ce7b1b24f6855d362167d0af5a38ed5a5ddb54b32bb0ff3'
    run(['docker','version'])
    expected=json.loads((ROOT/'EXPECTED-IMAGE.json').read_text())
    def conversion_guard():
        assert time.monotonic()<work_end,'CONVERSION_FINITE_DEADLINE'
    free=os.statvfs(ROOT);assert free.f_bavail*free.f_frsize>=6442450944,'HOSTED_IMPORT_FOOTPRINT_FLOOR_6GIB'
    compatible,conversionReceipt=convert(archive,ROOT/'converted-image',expected,conversion_guard)
    assert conversionReceipt['dockerArchiveBytes']==190689280 and conversionReceipt['dockerArchiveSHA256']=='cf56f0a5a0422785b12d328b94aea97026d645eed8b5904a31d7c703669d29de','ACCEPTED_DETERMINISTIC_REPRESENTATION_BYTES'
    save('SAME-IMAGE-REPRESENTATION.json',conversionReceipt)
    free=os.statvfs(ROOT);assert free.f_bavail*free.f_frsize>=2147483648+201326592+536870912+1073741824+612368384,'REMAINING_LOADER_IMAGE_PG_WRITE_FLOOR'
    run(['docker','load','--input',str(compatible)],120)
    image=json.loads(run(['docker','image','inspect',CONFIG])[0])[0]
    assert image['Id']==CONFIG and image['Architecture']=='amd64' and image['Os']=='linux'
    assert image['RootFS']['Layers']==expected['diffIDs'],'LOADED_ORDERED_RAW_DIFFIDS'
    assert image['Config']['User']=='bun' and image['Config']['Cmd']==['bun','run','deploy/backend/server.ts'];save('loaded-image.json',image)
    run(['docker','pull',PG],120)
    # Resolve exact pull result to image ID; bind inspected digest rather than assume ID convention.
    pgimage=json.loads(run(['docker','image','inspect',PG])[0])[0];assert PG in pgimage['RepoDigests'];pgid=pgimage['Id'];save('pg-image.json',pgimage)
    pg=start('pg',pgid,{'POSTGRES_USER':'fixture_admin','POSTGRES_DB':'runtime_boot','POSTGRES_HOST_AUTH_METHOD':'trust'},['postgres','-c','listen_addresses=127.0.0.1','-c','shared_buffers=32MB','-c','max_connections=40'])
    end=min(work_end,time.monotonic()+45);ready=False
    while time.monotonic()<end:
        kernel_witness('pg',inspect(pg));_,code=run(['docker','exec',pg,'pg_isready','-q','-h','127.0.0.1','-p','5432','-U','fixture_admin','-d','runtime_boot','-t','2'],limit=5,allowed=(0,1,2))
        if code==0:ready=True;break
        time.sleep(.2)
    assert ready,'BOUNDED_PG_READINESS_FAILED'
    setup=start('setup',CONFIG,{'RUNTIME_SYNTHETIC_ONLY':'1','QUALIFY_DEADLINE_MS':str(int((time.time()+45)*1000))},['bun','run','/qualification/setup.ts'])
    (CONTROL/'setup.go').write_text('go\n');wait_exit('setup',45)
    env={'PLATFORM_ENV':'staging','DATABASE_URL':'postgres://runtime_service:synthetic-only@127.0.0.1:5432/runtime_boot','NETWORK_DATABASE_URL':'postgres://runtime_service:synthetic-only@127.0.0.1:5432/runtime_boot','MIGRATE_ON_BOOT':'0','PLATFORM_DB_ENVIRONMENT_INIT':'0','BUILD_ID':'a54d85c9aca1654ddefaf9313b9f3a9a446fe1ae','BACKEND_STAFF':'off','TICK_MS':'3600000','PLATFORM_HASH_KEY':'synthetic-hash-'*4,'LEAK_LABEL_KEY':'synthetic-leak-'*4,'PLATFORM_PROXY_SECRET':'synthetic-proxy-'*4,'PLATFORM_SESSION_SECRET':'synthetic-session-'*4,'SERVICE_TURN_SECRET':'synthetic-turn-'*4,'TURNSTILE_SECRET_KEY':'synthetic','OTP_PROVIDER':'twilio','TWILIO_ACCOUNT_SID':'ACsynthetic','TWILIO_AUTH_TOKEN':'synthetic','TWILIO_VERIFY_SERVICE_SID':'VAsynthetic','NETWORK_CHANNEL':'dry-run','BLOOIO_ALLOW_SEND':'0','NTWRK_LIVE_APPROVED':'0','SLOP_LIVE_APPROVED':'0','FRIENDS_LIVE_APPROVED':'0','PEON_LIVE_APPROVED':'0','CLEF_RATINGS':'off','NETWORK_CLOUD_AUTH_ENABLED':'true','NETWORK_CLOUD_AUTH_MODE':'own-pages-fresh-person-v1','NETWORK_CLOUD_AUTH_LOGIN_ORIGIN':'https://cloud.eliza.app','NETWORK_CLOUD_AUTH_API_ORIGIN':'https://api.eliza.app'}
    env['TURNSTILE_SITE_KEY']='synthetic-public-sitekey-runtime-only'
    env['MCP_CUSTOM_CHATGPT_SLOP']='off'
    env['STAGING_SITE_ORIGINS']=json.dumps({'ntwrk':'https://fresh-person.ntwrk-party-eliza.pages.dev','slop':'https://fresh-person.slop-date-eliza-stage.pages.dev','friends':'https://fresh-person.friends-help-eliza-stage.pages.dev','peon':'https://fresh-person.peon-biz-eliza-stage.pages.dev'})
    app=start('app',CONFIG,env);run(['docker','exec','--env','QUALIFY_DEADLINE_MS='+str(int((time.time()+35)*1000)),app,'bun','run','/qualification/probe.ts'],limit=40)
    kernel_witness('app',inspect(app));kernel_witness('pg',inspect(pg))
    stops.add(app);save('ONE-APP-TERM-INTENT.json',{'container':app,'pid':containers['app']['pid'],'birth':containers['app']['birth'],'signal':'SIGTERM'})
    run(['docker','kill','--signal=SIGTERM',app],cleanup=True);wait_exit('app',35,cleanup=True)
    logs=run(['docker','logs',app],cleanup=True)[0].decode();assert 'shutdown complete' in logs and '"clean":true' in logs
    kernel_witness('pg',inspect(pg,cleanup=True))
    pgStopIntent=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
    save('ONE-PG-SMART-STOP-INTENT.json',{'container':pg,'created':containers['pg']['created'],'image':containers['pg']['image'],'pid':containers['pg']['pid'],'birth':containers['pg']['birth'],'atUTC':pgStopIntent,'maximumStops':1})
    pgStop,pgStopCode=run(['docker','exec','--user','postgres',pg,'pg_ctl','-D','/var/lib/postgresql/data','-m','smart','-w','-t','20','stop'],limit=25,allowed=(0,137),cleanup=True)
    wait_exit('pg',25,cleanup=True)
    pgTerminal=inspect(pg,cleanup=True);ps=containers['pg']
    assert pgTerminal['Id']==pg and pgTerminal['Created']==ps['created']and pgTerminal['Image']==ps['image']and pgTerminal['Name']==ps['name']
    assert pgTerminal['State']['Pid']==0 and not pgTerminal['State']['Running']and not pgTerminal['State']['OOMKilled']and pgTerminal['State']['ExitCode']==0
    pgLogSeq=seq+1
    run(['docker','logs','--timestamps','--since',pgStopIntent,'--tail','80',pg],cleanup=True)
    pgLogReceipt=json.loads((OUT/f'command-{pgLogSeq:03}.json').read_text())
    assert pgLogReceipt['returncode']==0 and pgLogReceipt['reaped']is True and not pgLogReceipt['truncated']and not pgLogReceipt['deadlineExceeded']and not pgLogReceipt.get('drainError')
    def stamp_ns(text):
        match=re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[.](\d{1,9}))?Z',text)
        assert match,'EXACT_DOCKER_RFC3339_TIMESTAMP'
        seconds=int(datetime.datetime.fromisoformat(match[1]+'+00:00').timestamp())
        return seconds*1000000000+int((match[2]or'').ljust(9,'0'))
    intentNS=stamp_ns(pgStopIntent);markers=[]
    # stdout and stderr remain independently retained; order by exact Docker nanosecond prefix.
    for stream in ['stdout','stderr']:
        for line in pgLogReceipt[stream].splitlines():
            fields=line.split(' ',1)
            assert len(fields)==2,'TIMESTAMPED_PG_LOG_LINE'
            at=stamp_ns(fields[0])
            if at<intentNS:continue
            payload=fields[1]
            if not re.search(r'\[1\]\s+LOG:\s+',payload):continue
            for label in ['received smart shutdown request','database system is shut down']:
                if payload.endswith(label):markers.append({'atNS':at,'marker':label,'stream':stream})
    requested=[x for x in markers if x['marker']=='received smart shutdown request']
    terminal=[x for x in markers if x['marker']=='database system is shut down']
    assert len(requested)==len(terminal)==1 and intentNS<=requested[0]['atNS']<=terminal[0]['atNS'],'PID1_POST_INTENT_SMART_THEN_SHUTDOWN'
    save('EXACT-PG-SMART-CLOSURE.json',{'pgCtlClientReturnCode':pgStopCode,'knownExec137Preserved':pgStopCode==137,'terminal':pgTerminal['State'],'exactIdentityVerified':True,'stopIntentUTC':pgStopIntent,'logCommandReceipt':f'command-{pgLogSeq:03}.json','PID1PostIntentMarkers':markers})
    outcome.update(passed=True,state='ACTUAL_RETAINED_A54_MCP_ON_PUBLIC_CONFIG_AND_EXACT_CLOSURE_PASS')
except BaseException as error:
    outcome.update(state='HOLD_NO_RETRY_RUNTIME_UNQUALIFIED',error=type(error).__name__,reason=str(error)[:512])
finally:
    if not outcome['passed']:
        # Preserve primary error unmodified. Diagnostic failures cannot turn it into a new cause.
        try:outcome['failureEvidence']=capture_owned_failure_evidence()
        except BaseException as diagnosticError:outcome['failureEvidence']={'diagnosticError':type(diagnosticError).__name__+':'+str(diagnosticError)[:256]}
    outcome.update(containers=containers,clientCustody=[{k:c.get(k) for k in ['pid','birth','started','returncode','reaped','signals','retries','bytes','retainedBytes','truncated','deadlineExceeded']} for c in clients],oneAppSigtermIDs=list(stops),unknownClient=unknown,forcedStops=0,removals=0,retries=0,controllerElapsedSeconds=time.monotonic()-started,closureClaim='PASS only for explicitly recorded terminal containers; failures retain IDs and rely on disclosed disposable hosted runner teardown, not graceful-closure acceptance')
    save('RESULT.json',outcome,final=True)
raise SystemExit(0 if outcome['passed'] else 1)
