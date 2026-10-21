"""Repackage verified OCI layers for Docker's manifest.json loader; never extract a rootfs."""
from pathlib import Path
import hashlib,io,json,os,re,stat,tarfile,time,zlib
HEX=re.compile(r'^sha256:([0-9a-f]{64})$')
CHUNK=65536

def require(ok,reason):
    if not ok:raise RuntimeError(reason)
def digest(path,guard):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while True:
            guard();block=f.read(CHUNK)
            if not block:break
            h.update(block)
    return h.hexdigest()

def convert(source,destination,expected,guard,raw_limit=201326592,output_limit=201326592,free_floor=2147483648):
    source=Path(source);destination=Path(destination)
    require(source.is_file() and not source.is_symlink(),'REGULAR_OCI_INPUT')
    before=source.stat();identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    require(before.st_size==expected['archiveBytes'],'EXACT_OCI_SIZE')
    require(digest(source,guard)==expected['archiveSHA256'],'EXACT_OCI_SHA256')
    require(identity(source.stat())==identity(before),'INPUT_CHANGED_DURING_HASH')
    require(not destination.exists() and not destination.is_symlink(),'NEW_CONVERSION_DIRECTORY_ONLY')
    guard();destination.mkdir(mode=0o700)
    written=0
    def charge(n,limit,count):
        guard();require(count+n<=limit,'OUTPUT_BOUNDARY')
        fs=os.statvfs(destination);require(fs.f_bavail*fs.f_frsize>=free_floor+n,'HOST_FREE_FLOOR')
    metadata={};layer_records=[];raw_total=0;layer_paths=[]
    with tarfile.open(source,'r:') as archive:
        members={}
        for member in archive:
            guard();name=member.name
            require(name not in members and len(members)<32,'DUPLICATE_OR_TOO_MANY_OCI_MEMBERS')
            require(member.isfile() or member.isdir(),'OUTER_MEMBER_REGULAR_OR_DIRECTORY')
            require(name in ['blobs','blobs/sha256','oci-layout','index.json'] or re.fullmatch(r'blobs/sha256/[0-9a-f]{64}',name),'OUTER_PATH_ALLOWLIST')
            require(0<=member.size<=expected['archiveBytes'],'OUTER_MEMBER_SIZE')
            members[name]=member
        def read_small(name):
            require(name in members and members[name].isfile() and members[name].size<=65536,'SMALL_OCI_METADATA')
            guard();data=archive.extractfile(members[name]).read(65537);require(len(data)==members[name].size,'METADATA_SIZE');return data
        require(json.loads(read_small('oci-layout'))=={'imageLayoutVersion':'1.0.0'},'OCI_LAYOUT')
        index=json.loads(read_small('index.json'));require(index.get('schemaVersion')==2 and len(index.get('manifests',[]))==1,'ONE_OCI_MANIFEST')
        def desc_blob(desc):
            match=HEX.fullmatch(desc['digest']);require(match is not None,'SHA256_DESCRIPTOR')
            data=read_small('blobs/sha256/'+match[1]);require(len(data)==desc['size'] and 'sha256:'+hashlib.sha256(data).hexdigest()==desc['digest'],'DESCRIPTOR_DIGEST_SIZE');return data
        descriptor=index['manifests'][0];require(descriptor['digest']==expected['manifestDigest'],'EXACT_IMAGE_MANIFEST')
        manifest_raw=desc_blob(descriptor);manifest=json.loads(manifest_raw);require(manifest['schemaVersion']==2,'MANIFEST_SCHEMA')
        require(manifest['config']['digest']==expected['configDigest'],'EXACT_CONFIG_DESCRIPTOR')
        config=desc_blob(manifest['config']);cfg=json.loads(config)
        require(cfg['architecture']=='amd64' and cfg['os']=='linux','EXACT_PLATFORM')
        require(cfg['rootfs']['type']=='layers' and cfg['rootfs']['diff_ids']==expected['diffIDs'],'EXACT_ORDERED_RAW_DIFFIDS')
        require(manifest['layers']==expected['layers'],'EXACT_ORDERED_COMPRESSED_DESCRIPTORS')
        require(len(set(expected['diffIDs']))==len(expected['diffIDs']),'UNIQUE_RAW_LAYERS')
        allowed={'index.json','oci-layout','blobs','blobs/sha256','blobs/sha256/'+descriptor['digest'][7:],'blobs/sha256/'+manifest['config']['digest'][7:]}|{'blobs/sha256/'+x['digest'][7:] for x in manifest['layers']}
        require(set(members)<=allowed,'NO_UNBOUND_OUTER_BLOBS')
        for i,desc in enumerate(manifest['layers']):
            guard();require(desc['mediaType']=='application/vnd.oci.image.layer.v1.tar+gzip','SUPPORTED_GZIP_LAYER_ONLY')
            name='blobs/sha256/'+desc['digest'][7:];member=members.get(name)
            require(member is not None and member.isfile() and member.size==desc['size'],'EXACT_LAYER_MEMBER_SIZE')
            path=destination/(expected['diffIDs'][i][7:]+'.layer.tar');compressed_hash=hashlib.sha256();raw_hash=hashlib.sha256();compressed_count=0;raw_count=0;dec=zlib.decompressobj(16+zlib.MAX_WBITS)
            with archive.extractfile(member) as stream,path.open('xb') as out:
                while True:
                    guard();chunk=stream.read(CHUNK)
                    if not chunk:break
                    compressed_count+=len(chunk);require(compressed_count<=desc['size'],'COMPRESSED_LAYER_BOUND');compressed_hash.update(chunk)
                    pending=chunk
                    while pending:
                        guard();plain=dec.decompress(pending,CHUNK);pending=dec.unconsumed_tail
                        require(not dec.unused_data,'NO_GZIP_TRAILING_OR_CONCATENATED_DATA')
                        if plain:
                            require(raw_count+len(plain)<=expected['rawBytes'][i],'PER_LAYER_RAW_BOUND')
                            charge(len(plain),raw_limit,raw_total);out.write(plain);raw_count+=len(plain);raw_total+=len(plain);written+=len(plain);raw_hash.update(plain)
                require(dec.eof and not dec.unused_data and not dec.unconsumed_tail,'COMPLETE_SINGLE_GZIP_STREAM')
                out.flush();os.fsync(out.fileno())
            require(compressed_count==desc['size'] and 'sha256:'+compressed_hash.hexdigest()==desc['digest'],'COMPRESSED_LAYER_HASH')
            require(raw_count==expected['rawBytes'][i] and 'sha256:'+raw_hash.hexdigest()==expected['diffIDs'][i],'RAW_DIFFID_HASH')
            layer_paths.append(path);layer_records.append({'compressedDigest':desc['digest'],'compressedBytes':compressed_count,'diffID':expected['diffIDs'][i],'rawBytes':raw_count})
    require(identity(source.stat())==identity(before),'INPUT_IDENTITY_UNCHANGED')
    config_name=expected['configDigest'][7:]+'.json'
    docker_manifest=[{'Config':config_name,'RepoTags':[],'Layers':[x['diffID'][7:]+'/layer.tar' for x in layer_records]}]
    manifest_bytes=(json.dumps(docker_manifest,separators=(',',':'))+'\n').encode()
    output=destination/'image.docker.tar'
    class BoundWriter:
        def __init__(self,stream):self.stream=stream;self.count=0;self.hash=hashlib.sha256()
        def write(self,data):
            charge(len(data),output_limit,self.count);self.stream.write(data);self.count+=len(data);self.hash.update(data);return len(data)
        def tell(self):return self.count
        def flush(self):self.stream.flush()
    with output.open('xb') as file:
        writer=BoundWriter(file)
        with tarfile.open(fileobj=writer,mode='w|',format=tarfile.USTAR_FORMAT) as target:
            def add(name,size,stream):
                guard();info=tarfile.TarInfo(name);info.size=size;info.mode=0o644;info.uid=info.gid=0;info.mtime=0;target.addfile(info,stream)
            add(config_name,len(config),io.BytesIO(config))
            for record,path in zip(layer_records,layer_paths):
                with path.open('rb') as stream:add(record['diffID'][7:]+'/layer.tar',record['rawBytes'],stream)
            add('manifest.json',len(manifest_bytes),io.BytesIO(manifest_bytes))
        writer.flush();os.fsync(file.fileno())
    # Independent reread validates every written raw layer and untouched config bytes.
    with tarfile.open(output,'r:') as check:
        checked={m.name:m for m in check};require(len(checked)==len(layer_records)+2,'DOCKER_TAR_MEMBER_COUNT')
        require(check.extractfile(config_name).read()==config,'CONFIG_BYTES_IDENTICAL')
        require(json.load(check.extractfile('manifest.json'))==docker_manifest,'DOCKER_MANIFEST_IDENTICAL')
        for record in layer_records:
            m=checked[record['diffID'][7:]+'/layer.tar'];require(m.isfile() and m.size==record['rawBytes'],'WRITTEN_LAYER_SIZE');h=hashlib.sha256()
            with check.extractfile(m) as stream:
                while True:
                    guard();data=stream.read(CHUNK)
                    if not data:break
                    h.update(data)
            require('sha256:'+h.hexdigest()==record['diffID'],'WRITTEN_LAYER_DIFFID')
    require(output.stat().st_size==writer.count and digest(output,guard)==writer.hash.hexdigest(),'FINAL_DOCKER_ARCHIVE_SHA')
    receipt={'state':'SAME_CONFIG_ORDERED_RAW_DIFFIDS_DOCKER_ARCHIVE_REPRESENTATION_PASS','configDigest':expected['configDigest'],'OCIManifestDigest':expected['manifestDigest'],'sourceOCIArchiveSHA256':expected['archiveSHA256'],'layers':layer_records,'rawLayerBytes':raw_total,'dockerArchiveBytes':writer.count,'dockerArchiveSHA256':writer.hash.hexdigest(),'newRepresentationBytesWritten':written+writer.count,'configBytesUnchanged':True,'layerTarBytesUnchanged':True,'noRootfsExtraction':True,'imageLoaded':False,'rebuild':False}
    return output,receipt
