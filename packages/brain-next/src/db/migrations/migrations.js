import journal from './meta/_journal.json';
import m0000 from './0000_store.sql';
import m0001 from './0001_words.sql';
import m0002 from './0002_versions.sql';
import m0003 from './0003_vectors.sql';
import m0004 from './0004_work.sql';
import m0005 from './0005_stems.sql';
import m0006 from './0006_erasure.sql';
import m0007 from './0007_embedding.sql';
import m0008 from './0008_memories.sql';
import m0009 from './0009_exports.sql';
import m0010 from './0010_export_memories.sql';
import m0011 from './0011_groups.sql';
import m0012 from './0012_read_at.sql';
import m0013 from './0013_entity_indexes.sql';
import m0014 from './0014_erasure_counts.sql';

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
m0009,
m0010,
m0011,
m0012,
m0013,
m0014
    }
  }
  