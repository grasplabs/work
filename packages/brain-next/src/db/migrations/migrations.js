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
import m0015 from './0015_writer_erasure.sql';
import m0016 from './0016_writer_erasure_kind.sql';
import m0017 from './0017_writer_erasure_change.sql';
import m0018 from './0018_writer_erase_failures.sql';
import m0019 from './0019_writer_erase_sweep.sql';
import m0020 from './0020_work_key.sql';
import m0021 from './0021_removals.sql';
import m0022 from './0022_memory_outs.sql';
import m0023 from './0023_memory_judging.sql';
import m0024 from './0024_chunk_days.sql';
import m0025 from './0025_person_erasure.sql';

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
m0014,
m0015,
m0016,
m0017,
m0018,
m0019,
m0020,
m0021,
m0022,
m0023,
m0024,
m0025
    }
  }
  