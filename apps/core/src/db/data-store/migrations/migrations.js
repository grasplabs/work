import journal from './meta/_journal.json';
import m0000 from './0000_data_store.sql';
import m0001 from './0001_receipts.sql';
import m0002 from './0002_store_deletion.sql';
import m0003 from './0003_schemas_and_default_order.sql';
import m0004 from './0004_cursor_key.sql';
import m0005 from './0005_table_generations.sql';
import m0006 from './0006_schema_contract.sql';
import m0007 from './0007_record_refs.sql';
import m0008 from './0008_record_ref_cascade.sql';
import m0009 from './0009_schema_backfills.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008,
m0009
    }
  }
  