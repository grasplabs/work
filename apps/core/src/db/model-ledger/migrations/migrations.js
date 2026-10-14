import journal from './meta/_journal.json';
import m0000 from './0000_model_ledger.sql';
import m0001 from './0001_request_deadline.sql';
import m0002 from './0002_lineage_requests.sql';
import m0003 from './0003_request_scopes_scope_key.sql';
import m0004 from './0004_ledger_quota_policy.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004
    }
  }
  