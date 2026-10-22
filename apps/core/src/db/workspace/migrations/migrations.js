import journal from './meta/_journal.json';
import m0000 from './0000_chats.sql';
import m0001 from './0001_restricted_chats.sql';
import m0002 from './0002_agent_sessions.sql';
import m0003 from './0003_chat_sources.sql';
import m0004 from './0004_personal_chats.sql';
import m0005 from './0005_chat_drafts.sql';
import m0006 from './0006_chat_attachments.sql';
import m0007 from './0007_chat_owner_required.sql';
import m0008 from './0008_chat_code_runs.sql';
import m0009 from './0009_chat_build_jobs.sql';
import m0010 from './0010_dashboard_layouts.sql';
import m0011 from './0011_chat_projects.sql';
import m0012 from './0012_preview_releases.sql';
import m0013 from './0013_email_preferences.sql';
import m0014 from './0014_chat_draft_call_id.sql';
import m0015 from './0015_chat_documents.sql';
import m0016 from './0016_chat_run_sources.sql';
import m0017 from './0017_chat_last_at.sql';

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
m0017
    }
  }
  