import journal from './meta/_journal.json';
import m0000 from './0000_events.sql';
import m0001 from './0001_archives.sql';
import m0002 from './0002_archive_purges.sql';
import m0003 from './0003_active_weeks.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003
    }
  }
  