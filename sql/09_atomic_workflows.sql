-- Serialize human financial mutations across app replicas and commit their database effects atomically.
-- Agents do not expose this procedure as a tool. Direct owner-role access is trusted in this demo.
use role ZELIS_C2C_ROLE;
use database ZELIS_C2C;
use warehouse ZELIS_C2C_WH;
create table if not exists OPS.WORKFLOW_MUTEX (lock_name string, revision number);
insert into OPS.WORKFLOW_MUTEX select 'FINANCIAL', 0 where not exists (
  select 1 from OPS.WORKFLOW_MUTEX where lock_name='FINANCIAL');
create table if not exists OPS.WORKFLOW_REQUESTS (idem_key string, action string, request variant);
create or replace procedure CORE.FINANCIAL_MUTATION(P_ACTION string, P_ARGS variant)
returns variant language sql execute as owner as
$$
declare result variant; action string; entity string;
begin
  begin transaction;
  -- UPDATE takes a transactional write lock; competing mutations wait or fail without partial writes.
  update OPS.WORKFLOW_MUTEX set revision=revision+1 where lock_name='FINANCIAL';
  action := (select any_value(action) from OPS.IDEMPOTENCY where idem_key=:P_ARGS:key::string);
  if (action is not null and action <> P_ACTION) then
    rollback;
    return object_construct('ok',false,'code','IDEMPOTENCY_CONFLICT');
  end if;
  if (exists (select 1 from OPS.WORKFLOW_REQUESTS where idem_key=:P_ARGS:key::string
      and (action <> :P_ACTION or request <> :P_ARGS))) then
    rollback;
    return object_construct('ok',false,'code','IDEMPOTENCY_CONFLICT');
  end if;
  if (not exists (select 1 from OPS.WORKFLOW_REQUESTS where idem_key=:P_ARGS:key::string)) then
    insert into OPS.WORKFLOW_REQUESTS select :P_ARGS:key::string,:P_ACTION,:P_ARGS;
  end if;
  case (P_ACTION)
    when 'RESOLVE_EXCEPTION' then
      call CORE.RESOLVE_EXCEPTION_IMPL(:P_ARGS:id::string,:P_ARGS:version::int,:P_ARGS:decision::string,
        :P_ARGS:value::number(18,2),:P_ARGS:proposal::string,:P_ARGS:actor::string,:P_ARGS:persona::string,
        :P_ARGS:key::string,:P_ARGS:note::string) into :result;
    when 'CREATE_BATCHES' then
      call CORE.CREATE_BATCHES_IMPL(:P_ARGS:actor::string,:P_ARGS:persona::string,:P_ARGS:key::string) into :result;
    when 'APPROVE_BATCH' then
      call CORE.APPROVE_BATCH_IMPL(:P_ARGS:id::string,:P_ARGS:version::int,:P_ARGS:actor::string,
        :P_ARGS:persona::string,:P_ARGS:key::string) into :result;
    when 'RELEASE_BATCH' then
      call CORE.RELEASE_BATCH_IMPL(:P_ARGS:id::string,:P_ARGS:version::int,:P_ARGS:actor::string,
        :P_ARGS:persona::string,:P_ARGS:key::string) into :result;
    else
      rollback;
      return object_construct('ok',false,'code','INVALID_ACTION');
  end case;
  if (coalesce(result:ok::boolean,false)) then commit; else rollback; end if;
  return result;
exception when other then
  rollback;
  raise;
end;
$$;
create or replace procedure CORE.RESOLVE_EXCEPTION(P_EXCEPTION_ID string,P_EXPECTED_VERSION int,P_DECISION string,
  P_VALUE number(18,2),P_PROPOSAL_ID string,P_ACTOR string,P_PERSONA string,P_IDEM_KEY string,P_NOTE string)
returns variant language sql execute as owner as
$$
declare result variant;
begin
  call CORE.FINANCIAL_MUTATION('RESOLVE_EXCEPTION',object_construct_keep_null('id',:P_EXCEPTION_ID,
    'version',:P_EXPECTED_VERSION,'decision',:P_DECISION,'value',:P_VALUE,'proposal',:P_PROPOSAL_ID,
    'actor',:P_ACTOR,'persona',:P_PERSONA,'key',:P_IDEM_KEY,'note',:P_NOTE)) into :result;
  return result;
end;
$$;
create or replace procedure CORE.CREATE_BATCHES(P_ACTOR string,P_PERSONA string,P_IDEM_KEY string)
returns variant language sql execute as owner as
$$
declare result variant;
begin
  call CORE.FINANCIAL_MUTATION('CREATE_BATCHES',object_construct('actor',:P_ACTOR,'persona',:P_PERSONA,'key',:P_IDEM_KEY)) into :result;
  return result;
end;
$$;
create or replace procedure CORE.APPROVE_BATCH(P_BATCH_ID string,P_EXPECTED_VERSION int,P_ACTOR string,P_PERSONA string,P_IDEM_KEY string)
returns variant language sql execute as owner as
$$
declare result variant;
begin
  call CORE.FINANCIAL_MUTATION('APPROVE_BATCH',object_construct('id',:P_BATCH_ID,'version',:P_EXPECTED_VERSION,
    'actor',:P_ACTOR,'persona',:P_PERSONA,'key',:P_IDEM_KEY)) into :result;
  return result;
end;
$$;
create or replace procedure CORE.RELEASE_BATCH(P_BATCH_ID string,P_EXPECTED_VERSION int,P_ACTOR string,P_PERSONA string,P_IDEM_KEY string)
returns variant language sql execute as owner as
$$
declare result variant; path string;
begin
  call CORE.FINANCIAL_MUTATION('RELEASE_BATCH',object_construct('id',:P_BATCH_ID,'version',:P_EXPECTED_VERSION,
    'actor',:P_ACTOR,'persona',:P_PERSONA,'key',:P_IDEM_KEY)) into :result;
  if (coalesce(result:ok::boolean,false)) then
    if (not regexp_like(P_BATCH_ID,'BAT-[A-Z0-9-]+')) then
      return object_insert(result,'remittance_export','PENDING_INVALID_PATH',true);
    end if;
    path := '835/' || P_BATCH_ID || '.835';
    begin
      execute immediate 'copy into @OPS.REMITTANCE/' || :path || ' from (select content from OPS.REMITTANCE_FILES where batch_id = ''' ||
        :P_BATCH_ID || ''' and format = ''835'') file_format = (type = csv field_delimiter = none compression = none ' ||
        'field_optionally_enclosed_by = none escape_unenclosed_field = none) single = true header = false overwrite = true';
      result := object_insert(result,'remittance_export','EXPORTED',true);
    exception when other then
      result := object_insert(result,'remittance_export','PENDING_RETRY',true);
    end;
  end if;
  return result;
end;
$$;
