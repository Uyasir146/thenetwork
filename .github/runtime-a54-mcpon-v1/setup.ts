/** Synthetic PG only; uses migration code/assets inside the retained canonical image. */
import { SQL } from 'bun';
import { migrate } from '/app/packages/observatory/db/migrate.ts';

const deadline=Number(process.env.QUALIFY_DEADLINE_MS);
const guard=()=>{if(!Number.isFinite(deadline)||Date.now()>=deadline)throw Error('qualification deadline');};
if(process.env.RUNTIME_SYNTHETIC_ONLY!=='1')throw Error('synthetic fixture guard');
guard();
while(!(await Bun.file('/control/setup.go').exists())){guard();await Bun.sleep(100);}
guard();
const owner='postgres://fixture_admin@127.0.0.1:5432/runtime_boot';
const migration=await migrate(owner,{lockTimeout:'5s'});
guard();
const sql=new SQL({url:owner,max:1,connection:{statement_timeout:'15000'}});
try{
  await sql.unsafe("create role runtime_service login inherit nosuperuser nocreatedb nocreaterole nobypassrls password 'synthetic-only'");
  await sql.unsafe('grant network_service to runtime_service; grant connect on database runtime_boot to runtime_service');
  await sql.unsafe("update platform.settings set value='staging' where key='environment' and value='dev'");
  guard();
  const [role]=await sql`select rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolcanlogin,pg_has_role('runtime_service','network_service','MEMBER') as member from pg_roles where rolname='runtime_service'`;
  if(!role||role.rolsuper||role.rolbypassrls||role.rolcreatedb||role.rolcreaterole||!role.rolinherit||!role.rolcanlogin||!role.member)throw Error('limited runtime role verification');
  const [env]=await sql`select value from platform.settings where key='environment'`;
  if(env?.value!=='staging')throw Error('staging environment row');
  const [ownership]=await sql`select count(*)::int as owned from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner where r.rolname='runtime_service' and n.nspname not in ('pg_catalog','information_schema')`;
  if(ownership?.owned!==0)throw Error('runtime role must own no tables');
  const service=new SQL({url:'postgres://runtime_service:synthetic-only@127.0.0.1:5432/runtime_boot',max:1,connection:{statement_timeout:'15000'}});
  try{
    const [session]=await service`select current_user as role,current_database() as db`;
    const [serviceEnv]=await service`select value from platform.settings where key='environment'`;
    if(session?.role!=='runtime_service'||session?.db!=='runtime_boot'||serviceEnv?.value!=='staging')throw Error('actual limited login readback');
    const [acl]=await service`select c.relrowsecurity as rls, pg_get_userbyid(c.relowner)=current_user as owner,
      has_table_privilege(current_user,c.oid,'SELECT') as can_read, has_table_privilege(current_user,c.oid,'INSERT') as can_insert,
      has_table_privilege(current_user,c.oid,'UPDATE') as can_update, has_table_privilege(current_user,c.oid,'DELETE') as can_delete
      from pg_class c where c.oid='platform.profile_suggestion_connection_receipts'::regclass`;
    if(!acl?.rls||acl.owner||!acl.can_read||!acl.can_insert||acl.can_update||acl.can_delete)throw Error('actual cleanup receipt restricted ACL');

  }finally{await service.close();}
  const ledger=await sql`select id from public.__migrations where id in ('0039_profile_suggestions','0040_profile_suggestion_connection_receipts','0041_profile_cleanup_results') order by id`;
  if(ledger.map(x=>x.id).join(',')!=='0039_profile_suggestions,0040_profile_suggestion_connection_receipts,0041_profile_cleanup_results')throw Error('current image migrations 0039-0041 missing');
  guard();
  console.log(JSON.stringify({state:'SYNTHETIC_IMAGE_MIGRATION_SETUP_COMPLETE',migrationsFromImage:true,applied:migration.applied.length,role:'runtime_service',superuser:false,bypassRLS:false,ownsTables:false,environment:'staging',serviceLoginVerified:true}));
}finally{await sql.close();}
