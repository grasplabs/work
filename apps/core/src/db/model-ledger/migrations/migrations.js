import journal from './meta/_journal.json';
import m0000 from './0000_model_ledger.sql';
import m0001 from './0001_request_deadline.sql';
import m0002 from './0002_lineage_requests.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002
    }
  }
  