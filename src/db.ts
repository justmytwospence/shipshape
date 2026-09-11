import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './config.ts'

/**
 * Runtime state only. Policy is tracked YAML in the watched repository; per-service config is
 * `shipshape.*` labels in the compose files. Everything here except verdict/cost history
 * is reconstructible from the registries, git, and those two sources.
 */

export type Db = Database.Database

let db: Db | null = null

export function getDb(): Db {
  if (db) return db
  mkdirSync(dirname(paths.db), { recursive: true })
  db = new Database(paths.db)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001-initial',
    sql: `
    -- One row per (stack, service) found in the compose files, refreshed every scan.
    CREATE TABLE images (
      stack           TEXT NOT NULL,
      service         TEXT NOT NULL,
      compose_file    TEXT NOT NULL,
      image_ref       TEXT NOT NULL,   -- full ref as written, e.g. lscr.io/x/y:1.2.3
      registry        TEXT NOT NULL,   -- docker.io | ghcr.io | lscr.io | quay.io | ...
      repository      TEXT NOT NULL,   -- namespace/name
      current_tag     TEXT,
      current_digest  TEXT,            -- when pinned tag@sha256:...
      watched         INTEGER NOT NULL DEFAULT 0,
      pattern         TEXT,            -- semver | v-semver | ... | regex
      tag_include     TEXT,
      policy_label    TEXT,            -- auto | gated | manual | skip (label override)
      source_label    TEXT,            -- shipshape.source override
      claude_label    TEXT,            -- 'required' => fail-closed for this service
      deploy_label    TEXT,            -- 'rm-first'
      unwatchable     TEXT,            -- reason: build | interpolated | disabled
      last_seen_at    TEXT NOT NULL,
      PRIMARY KEY (stack, service)
    );

    -- Tag inventory per repository, so "new since last scan" is answerable offline.
    CREATE TABLE tags_seen (
      registry     TEXT NOT NULL,
      repository   TEXT NOT NULL,
      tag          TEXT NOT NULL,
      digest       TEXT,
      published_at TEXT,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (registry, repository, tag)
    );

    -- image -> upstream source repo. Permanent: resolution is expensive (manifest walks
    -- count against the Docker Hub pull budget) and the answer effectively never changes.
    CREATE TABLE resolutions (
      registry    TEXT NOT NULL,
      repository  TEXT NOT NULL,
      source_url  TEXT,
      tier        TEXT NOT NULL,     -- annotation | override | lsio | claude | none
      detail      TEXT,
      resolved_at TEXT NOT NULL,
      PRIMARY KEY (registry, repository)
    );

    -- The update state machine.
    CREATE TABLE updates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      stack        TEXT NOT NULL,
      service      TEXT NOT NULL,
      image        TEXT NOT NULL,
      from_tag     TEXT NOT NULL,
      to_tag       TEXT NOT NULL,
      magnitude    TEXT NOT NULL,    -- major | minor | patch | digest
      tier         TEXT NOT NULL,    -- resolved static tier at detection time
      state        TEXT NOT NULL,    -- detected|pr_open|analyzed|merged|deploying
                                     -- |deployed|verified|superseded|failed|held
      detail       TEXT,
      detected_at  TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE (stack, service, from_tag, to_tag)
    );
    CREATE INDEX idx_updates_state ON updates(state);

    CREATE TABLE prs (
      update_id       INTEGER PRIMARY KEY REFERENCES updates(id) ON DELETE CASCADE,
      number          INTEGER NOT NULL,
      branch          TEXT NOT NULL,
      -- The sha the tool itself last pushed. If the remote branch has moved past this,
      -- the user has edited it: the branch becomes user-owned and is never force-pushed.
      head_sha_pushed TEXT NOT NULL,
      state           TEXT NOT NULL,  -- open | merged | closed
      user_owned      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      merged_at       TEXT
    );

    -- Keyed by image+versions, NOT by service: the same postgres bump in three stacks is
    -- analyzed once.
    CREATE TABLE verdicts (
      image           TEXT NOT NULL,
      from_tag        TEXT NOT NULL,
      to_tag          TEXT NOT NULL,
      summary         TEXT,
      severity        TEXT,
      breaking_changes TEXT,          -- JSON array
      migration_steps TEXT,           -- JSON array
      recommendation  TEXT,           -- approve | caution | block
      confidence      TEXT,           -- low | medium | high
      sources         TEXT,           -- JSON array
      model           TEXT,
      cost_usd        REAL,
      error           TEXT,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (image, from_tag, to_tag)
    );

    CREATE TABLE events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      level      TEXT NOT NULL,       -- info | warn | error
      kind       TEXT NOT NULL,       -- scan | sync | pr | analysis | deploy | policy
      stack      TEXT,
      service    TEXT,
      message    TEXT NOT NULL,
      detail     TEXT
    );
    CREATE INDEX idx_events_at ON events(at DESC);

    CREATE TABLE http_cache (
      url        TEXT PRIMARY KEY,
      etag       TEXT,
      body       TEXT,
      fetched_at TEXT NOT NULL
    );

    -- Docker Hub pull ledger and Claude monthly spend live here as simple counters.
    CREATE TABLE budgets (
      key        TEXT PRIMARY KEY,
      value      REAL NOT NULL,
      window     TEXT,
      updated_at TEXT NOT NULL
    );
  `,
  },
  {
    id: '002-digests-groups',
    sql: `
    -- Last-acknowledged digest for a rolling tag. Keyed by IMAGE, not service: huginn
    -- runs huginn-single-process:latest twice, so one baseline serves both and movement
    -- fans out per service at handling time.
    --
    -- Deliberately NOT tags_seen.digest: that column is refreshed as inventory on every
    -- scan, which would silently advance the baseline and swallow the movement event. A
    -- baseline may only advance when the digest checker acknowledges movement.
    CREATE TABLE digest_baselines (
      registry     TEXT NOT NULL,
      repository   TEXT NOT NULL,
      tag          TEXT NOT NULL,
      digest       TEXT NOT NULL,
      observed_at  TEXT NOT NULL,
      checked_at   TEXT NOT NULL,
      PRIMARY KEY (registry, repository, tag)
    );

    -- prs gains its own id plus group support, because one PR can carry several
    -- updates: immich-server and immich-machine-learning must move together or Immich
    -- runs version-skewed. Safe to drop and recreate -- no PR has ever been created.
    DROP TABLE prs;
    CREATE TABLE prs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      number          INTEGER NOT NULL,
      branch          TEXT NOT NULL,
      -- The sha the tool itself last pushed. A remote branch past this means the user
      -- edited it: it becomes user-owned and is never force-pushed again.
      head_sha_pushed TEXT NOT NULL,
      state           TEXT NOT NULL,          -- open | merged | closed
      user_owned      INTEGER NOT NULL DEFAULT 0,
      group_key       TEXT,                   -- null = singleton
      created_at      TEXT NOT NULL,
      merged_at       TEXT
    );
    CREATE TABLE pr_updates (
      pr_id     INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      update_id INTEGER NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      PRIMARY KEY (pr_id, update_id)
    );

    -- Latest named non-update outcome per service, so "needs a human" states are visible
    -- on the images page without log spelunking.
    ALTER TABLE images ADD COLUMN last_status TEXT;
    ALTER TABLE images ADD COLUMN last_detail TEXT;

    CREATE INDEX idx_updates_svc ON updates(stack, service, state);
  `,
  },
  {
    id: '003-constrained',
    sql: `
    -- A newer version exists but a deliberate tag.include pin suppressed it. Recorded
    -- so the UI can say "constrained" rather than showing the service as current -- a
    -- deliberate pin should look deliberate, not accidental.
    ALTER TABLE images ADD COLUMN constrained_from TEXT;
  `,
  },
  {
    id: '004-pr-scope',
    sql: `
    -- Whether a pull request still contains only the image-tag change shipshape wrote.
    -- 'tag-only' | 'modified'.
    --
    -- Every shipshape-authored PR starts tag-only by construction (the editor refuses to
    -- commit anything else), so the default backfills existing rows correctly. It flips
    -- to 'modified' when a human pushes to the branch -- which some updates genuinely
    -- require, e.g. an upstream that renames its image.
    --
    -- LOAD-BEARING FOR AUTO-MERGE: when that lands, the predicate must require
    -- scope = 'tag-only' in addition to canAutoMerge(). An edited branch contains work
    -- no policy or changelog verdict ever evaluated, so it always needs a human.
    ALTER TABLE prs ADD COLUMN scope TEXT NOT NULL DEFAULT 'tag-only';
  `,
  },
  {
    id: '005-scope-sha',
    sql: `
    -- The branch head that the scope column describes. Classification runs whenever the
    -- head moves away from this, in EITHER direction: keying it off "differs from what
    -- shipshape pushed" instead would strand a branch as 'modified' forever once someone
    -- restored it to shipshape's own commit, because that comparison stops being true.
    ALTER TABLE prs ADD COLUMN scope_sha TEXT;
  `,
  },
  {
    id: '006-proposals',
    sql: `
    -- Config changes drafted by a model to accompany an image bump.
    --
    -- Recorded whatever the outcome: an applied set, a refusal, or a notes-only result
    -- where nothing in the compose file needed to change. A refused proposal that left
    -- no trace would be indistinguishable from "nothing to do".
    --
    -- prs.scope gains a third value alongside 'tag-only' and 'modified': 'proposed',
    -- meaning shipshape added changes of its own. Like 'modified', it must never
    -- auto-merge -- the whole point is that nothing has verified those changes.
    CREATE TABLE proposals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id      INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      update_id  INTEGER NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      ops        TEXT NOT NULL,   -- JSON array of operations the model chose
      notes      TEXT NOT NULL,   -- JSON array of manual steps
      summary    TEXT,
      sources    TEXT,
      changed    TEXT,            -- JSON array of human-readable applied changes
      model      TEXT,
      error      TEXT,            -- refusal reason, when the ops could not be applied
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_proposals_pr ON proposals(pr_id);
  `,
  },
  {
    id: '007-llm-calls',
    sql: `
    -- One row per model call, so spend is explainable rather than merely known.
    --
    -- A single running total answers "how much" but never "why", which is the only
    -- question worth asking when a number looks wrong. Cache tokens are recorded
    -- separately because they are billed separately and are NOT part of input_tokens
    -- -- counting only input_tokens under-reports every cached call.
    CREATE TABLE llm_calls (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      model              TEXT NOT NULL,
      purpose            TEXT NOT NULL,   -- verdict | proposal
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      searches           INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX idx_llm_calls_created ON llm_calls(created_at);

    -- Operator-edited prompts. Absent row = use the file default, which is how every
    -- deployment starts and what "reset" returns to.
    CREATE TABLE prompts (
      name       TEXT PRIMARY KEY,   -- verdict | proposal
      body       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  },
  {
    id: '008-proposal-hunks',
    sql: `
    -- The proposal's own diff, captured when it is applied rather than reconstructed
    -- from GitHub later: at apply time both texts are exact and in hand.
    ALTER TABLE proposals ADD COLUMN hunks TEXT;
  `,
  },
  {
    id: '009-deploys',
    sql: `
    -- What actually reached the host. Separate from events because "did this deploy,
    -- and did it come up" is a question about services over time, not a log line.
    CREATE TABLE deploys (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number  INTEGER,
      stack      TEXT NOT NULL,
      services   TEXT NOT NULL,
      strategy   TEXT NOT NULL,   -- up | rm-first
      ok         INTEGER NOT NULL,
      healthy    INTEGER NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_deploys_created ON deploys(created_at);
  `,
  },
  {
    id: '010-model-tier',
    sql: `
    -- Every time the model was asked whether an update is routine, and what the static
    -- policy would have said instead.
    --
    -- Recorded even in shadow mode, where nothing acts on it. That is the point: the
    -- question "does this work well enough to enable" needs a track record, and a
    -- track record cannot be gathered after the fact.
    CREATE TABLE model_tier_decisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      image       TEXT NOT NULL,
      stack       TEXT,
      service     TEXT,
      from_tag    TEXT,
      to_tag      TEXT,
      magnitude   TEXT,
      static_tier TEXT NOT NULL,   -- what policy alone would have given
      promote     INTEGER NOT NULL,-- did every guard pass
      reason      TEXT NOT NULL,   -- the first guard that refused, or 'every guard passed'
      guards      TEXT NOT NULL,   -- JSON, so a refusal can be understood later
      enforced    INTEGER NOT NULL,-- was this acted on, or only observed
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_mtd_created ON model_tier_decisions(created_at);
  `,
  },
  {
    id: '011-collapse-gated',
    sql: `
    -- 'gated' was a fifth rung on the policy ladder that behaved in every decision
    -- exactly like 'manual' -- same merge answer, same PR answer, differing only in
    -- which word a badge showed. It is now an accepted spelling of 'manual' rather than
    -- a value anything produces, so stored rows are rewritten to match.
    --
    -- Reading code still normalises (policy.ts, normaliseTier) because a row can also
    -- arrive from a compose label, and a label is not covered by a migration.
    UPDATE updates SET tier = 'manual' WHERE tier = 'gated';
    UPDATE model_tier_decisions SET static_tier = 'manual' WHERE static_tier = 'gated';
  `,
  },
  {
    id: '012-digest',
    sql: `
    -- Routine notifications, held until the digest goes out.
    --
    -- A separate table rather than a query over \`events\`: events are an audit trail and
    -- record everything, including the dozens of scan lines nobody wants pushed at them.
    -- Deciding at write time which facts are worth a notification is the whole feature,
    -- and encoding that decision as a pattern match over log messages would be both
    -- fragile and invisible.
    --
    -- \`sent_at\` rather than DELETE on flush: a digest that failed to send must not take
    -- its contents with it, and having the last few digests still readable is worth one
    -- column.
    CREATE TABLE digest_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      category   TEXT NOT NULL,   -- opened | superseded | merged | deployed | held | drafted
      stack      TEXT,
      service    TEXT,
      summary    TEXT NOT NULL,   -- one line, already human-readable
      detail     TEXT,
      url        TEXT,
      sent_at    TEXT
    );
    CREATE INDEX idx_digest_pending ON digest_items(sent_at, id);
  `,
  },
  {
    id: '013-verify-rollback',
    sql: `
    -- The sha the merge produced, so a failed deploy can revert exactly what it applied.
    -- Captured at merge detection because GitHub hands it to us there and nowhere else:
    -- reconstructing it later means guessing which commit on main was this pull request.
    ALTER TABLE prs ADD COLUMN merge_commit_sha TEXT;

    -- The port this service serves HTTP on, harvested from the traefik loadbalancer
    -- label the service already declares. NULL means no probe -- either nothing is
    -- declared or \`shipshape.probe: off\` said not to. Probing the container directly
    -- rather than its public URL is deliberate: it bypasses the forward-auth that would
    -- answer 302 for every protected service, and the rate limiter that would eventually
    -- ban the prober.
    ALTER TABLE images ADD COLUMN probe_port INTEGER;

    -- The stack's own nightly dump recipe, copied from the docker-volume-backup label
    -- it already carries. Read and suggested to a human upgrading a datastore, never
    -- run: it was written for the backup container's context and sequencing, and
    -- automating someone else's label without an opt-in is how the WUD trigger-string
    -- era started.
    ALTER TABLE images ADD COLUMN archive_pre TEXT;

    -- \`deploys\` becomes the work queue as well as the record.
    --
    -- The queue half is what stops a merge being lost. The row is written in the same
    -- transaction that marks the pull request merged, so a crash between "merged" and
    -- "deployed" leaves an intent behind to retry, instead of a merge nothing will ever
    -- act on again -- which is what happened before, silently, because the merged state
    -- was committed first and the deploy had no try/catch anywhere on its path.
    ALTER TABLE deploys ADD COLUMN pr_id INTEGER REFERENCES prs(id);
    ALTER TABLE deploys ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
      -- pending | running | deployed | verified | degraded | failed | rolled-back | error
    ALTER TABLE deploys ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    -- What was running before, per service: image digest and reference, restart count,
    -- container id. The previous-good state has to be recorded rather than recomputed,
    -- because by the time a deploy has failed the thing it replaced is already gone.
    ALTER TABLE deploys ADD COLUMN snapshot TEXT;
    ALTER TABLE deploys ADD COLUMN verdict TEXT;    -- per-service signals, JSON
    ALTER TABLE deploys ADD COLUMN diagnosis TEXT;  -- logs, health log, model summary, JSON
    ALTER TABLE deploys ADD COLUMN started_at TEXT;
    ALTER TABLE deploys ADD COLUMN finished_at TEXT;
    -- When to look again. A deploy that passed its window is not yet \`verified\`: the
    -- failures a window misses are the slow ones.
    ALTER TABLE deploys ADD COLUMN recheck_at TEXT;
    CREATE INDEX idx_deploys_status ON deploys(status);

    -- Rows written before this migration are finished history, not queue entries.
    UPDATE deploys SET status = CASE WHEN healthy = 1 THEN 'deployed' ELSE 'failed' END;
  `,
  },
  {
    id: '014-network-mode',
    sql: `
    -- Which container's network namespace this service joins, when it joins one.
    --
    -- A service on \`network_mode: service:vpn\` has no network of its own: the daemon
    -- pins it to the *container id* of the one it shares with. Recreate that container
    -- and the id changes, so the dependent keeps running attached to a namespace that no
    -- longer exists -- alive, listed as up, and unreachable. Deploying "only the changed
    -- service" is therefore wrong for exactly these stacks, which is why this has to be
    -- known at deploy time rather than discovered afterwards.
    ALTER TABLE images ADD COLUMN network_mode TEXT;
  `,
  },
  {
    id: '015-operator-verbs',
    sql: `
    -- Who asked for this deploy. The queue is no longer the only thing that starts one:
    -- an operator can press Deploy, redeploy a rolling tag, retry a failure, or roll a
    -- version back, and the difference matters when reading history.
    ALTER TABLE deploys ADD COLUMN trigger TEXT NOT NULL DEFAULT 'queue';

    -- Which updates a deploy carried. This was derived from the pull request, which
    -- works only while every deploy has one -- a redeploy of a rolling tag and an
    -- operator rollback do not, so the link has to be stored rather than inferred.
    CREATE TABLE deploy_updates (
      deploy_id INTEGER NOT NULL REFERENCES deploys(id) ON DELETE CASCADE,
      update_id INTEGER NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      PRIMARY KEY (deploy_id, update_id)
    );
    INSERT OR IGNORE INTO deploy_updates (deploy_id, update_id)
      SELECT d.id, pu.update_id FROM deploys d
      JOIN pr_updates pu ON pu.pr_id = d.pr_id
      WHERE d.pr_id IS NOT NULL;

    -- "I have seen this" for the states that otherwise sit in the inbox forever: a
    -- failure, a rollback, a service that came up degraded.
    ALTER TABLE updates ADD COLUMN acked_at TEXT;

    -- A dismissal used to be a kind of supersession, which made it indistinguishable
    -- from "a newer version replaced it" and, worse, let the next scan re-offer it.
    -- It is its own terminal state now.
    UPDATE updates SET state = 'skipped' WHERE state = 'superseded' AND detail = 'dismissed';

    -- Analysis retries. A permanently failing (image, from, to) was retried on every
    -- poll cycle forever: 852 of the 3,776 events in this database are one repeated
    -- "changelog analysis failed" line.
    ALTER TABLE verdicts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE verdicts ADD COLUMN next_attempt_at TEXT;
    UPDATE verdicts SET attempts = 1 WHERE error IS NOT NULL;

    -- Repetition is a count, not N rows. Two messages account for 83% of this log
    -- ("holding N update(s)" 2,266 times, "changelog analysis failed" 852), which is
    -- enough noise to make the activity page useless for the thing it is for.
    ALTER TABLE events ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE events ADD COLUMN last_at TEXT;
    CREATE INDEX idx_events_dedupe ON events(kind, message);

    -- Fold the existing floods into their earliest row.
    UPDATE events SET
      count = (SELECT COUNT(*) FROM events e2
               WHERE e2.kind = events.kind AND e2.message = events.message
                 AND IFNULL(e2.stack,'') = IFNULL(events.stack,'')
                 AND IFNULL(e2.service,'') = IFNULL(events.service,'')),
      last_at = (SELECT MAX(e2.at) FROM events e2
                 WHERE e2.kind = events.kind AND e2.message = events.message
                   AND IFNULL(e2.stack,'') = IFNULL(events.stack,'')
                   AND IFNULL(e2.service,'') = IFNULL(events.service,''))
    WHERE (message LIKE 'holding % update(s)%' OR message = 'changelog analysis failed')
      AND id IN (
        SELECT MIN(id) FROM events
        WHERE message LIKE 'holding % update(s)%' OR message = 'changelog analysis failed'
        GROUP BY kind, message, IFNULL(stack,''), IFNULL(service,'')
      );
    DELETE FROM events
    WHERE (message LIKE 'holding % update(s)%' OR message = 'changelog analysis failed')
      AND id NOT IN (
        SELECT MIN(id) FROM events
        WHERE message LIKE 'holding % update(s)%' OR message = 'changelog analysis failed'
        GROUP BY kind, message, IFNULL(stack,''), IFNULL(service,'')
      );
  `,
  },
  {
    id: '016-instructions',
    sql: `
    -- A comment on an open pull request, and what shipshape did about it.
    --
    -- comment_id is namespaced ('issue:123' / 'review:456'): issue comments and review
    -- comments are independent id sequences and would otherwise collide. UNIQUE on it is
    -- the whole idempotency story -- ingestion is INSERT OR IGNORE, so a comment can be
    -- seen on a hundred polls without being acted on twice.
    --
    -- shipshape's own replies are recorded here too, as status 'ours'. It authenticates
    -- with a fine-grained PAT, so its comments carry the OPERATOR'S login and author
    -- identity cannot tell bot from human. Recording the id that createComment hands
    -- back is exact, unspoofable, and immune to quoting; the first-line marker is the
    -- readable half of the same guard.
    --
    -- status is deliberately not handled_at. The claim has to be taken before a model
    -- call that can run for minutes, and the auto-merge interlock has to keep holding
    -- for every one of them -- one column cannot answer both "is anyone working on
    -- this" and "is this finished".
    CREATE TABLE instructions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id        INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      comment_id   TEXT NOT NULL UNIQUE,         -- issue:<id> | review:<id>
      kind         TEXT NOT NULL,                -- issue | review
      author       TEXT NOT NULL,
      body         TEXT NOT NULL,
      url          TEXT,
      path         TEXT,                         -- review comments: the file
      line         INTEGER,                      -- review comments: the line
      context      TEXT,                         -- JSON: diff_hunk, in_reply_to
      commented_at TEXT NOT NULL,                -- GitHub's created_at, not ours
      status       TEXT NOT NULL DEFAULT 'new',  -- new|working|done|failed|stale|ours
      attempts     INTEGER NOT NULL DEFAULT 0,
      claimed_at   TEXT,
      action       TEXT,                         -- answer|edit|hold|rerun-review|skip
      reply        TEXT,
      reply_id     TEXT,
      model        TEXT,
      error        TEXT,
      created_at   TEXT NOT NULL,
      handled_at   TEXT
    );
    CREATE INDEX idx_instructions_pending ON instructions(status, pr_id);

    -- Which instruction produced these changes, when one did.
    --
    -- A revision writes a proposals row like any other drafted change, and that is not
    -- bookkeeping. classifyScope only calls a branch 'proposed' when a proposals row
    -- exists; without one a revision commit is relabelled 'modified', which tells the
    -- operator their branch was edited by hand (it was not), disables the propose path
    -- on that pull request forever, and silently downgrades auto-rollback to a
    -- suggestion.
    ALTER TABLE proposals ADD COLUMN instruction_id INTEGER REFERENCES instructions(id);

    -- "Don't merge this yet", as a fact about the pull request rather than about the
    -- comment that asked for it. It has to outlive the instruction, or the hold lasts
    -- exactly as long as it takes to post the reply.
    ALTER TABLE prs ADD COLUMN hold_reason TEXT;
    ALTER TABLE prs ADD COLUMN hold_at TEXT;

    -- The rollout watermark, written by SQLite so it is the moment the feature arrived
    -- rather than whenever the process next started. Open pull requests already carry
    -- months of comments; without this the first tick would work through all of them.
    --
    -- Two keys because they answer different questions. 'since' is the payload window
    -- for the list calls; 'epoch' is the decision. An old comment that is edited today
    -- reappears in a 'since' window and must still be refused on its created_at.
    INSERT OR IGNORE INTO budgets (key, value, window, updated_at)
      VALUES ('revise.epoch', 0, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                                 strftime('%Y-%m-%dT%H:%M:%SZ','now'));
    INSERT OR IGNORE INTO budgets (key, value, window, updated_at)
      VALUES ('revise.since', 0, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                                 strftime('%Y-%m-%dT%H:%M:%SZ','now'));
  `,
  },
  {
    id: '017-digest-due',
    sql: `
    -- A digest that is owed but not yet sent.
    --
    -- The schedule firing and the digest going out stopped being the same moment when
    -- the digest started waiting for the work to finish. What sits between them is a
    -- decision already taken -- "this morning's summary is due" -- and a decision that
    -- can be pending for twenty minutes belongs in the database, not in a timer's
    -- closure: a restart at 08:03 would otherwise fold the whole morning into tomorrow's
    -- summary under tomorrow's date.
    --
    -- One row, enforced. Two rows would mean two digests owed at once, which is not a
    -- state that exists: a second occurrence while one is still owed keeps the first
    -- deadline (INSERT OR IGNORE), so a digest waiting on a slow deploy cannot have its
    -- clock reset out from under it.
    CREATE TABLE digest_due (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      due_at   TEXT NOT NULL,   -- when the schedule fired
      deadline TEXT NOT NULL    -- when it goes out regardless
    );
  `,
  },
  {
    id: '018-verdict-rerun',
    sql: `
    -- Someone asked for this changelog to be read again.
    --
    -- A column rather than deleting the verdict, and that is the whole point. With no
    -- verdict the gate falls back to static policy, which merges an auto-rung update --
    -- so deleting a block to make room for a re-read, and then having that re-read fail,
    -- would turn "held" into "merged". The old verdict stays in force until a new one
    -- replaces it, and a failed re-read leaves it exactly where it was.
    ALTER TABLE verdicts ADD COLUMN rerun_requested_at TEXT;
  `,
  },
]

function migrate(d: Db): void {
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const applied = new Set(
    d.prepare(`SELECT id FROM _migrations`).all().map((r) => (r as { id: string }).id),
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    d.transaction(() => {
      d.exec(m.sql)
      d.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`).run(
        m.id,
        new Date().toISOString(),
      )
    })()
  }
}

export type EventLevel = 'info' | 'warn' | 'error'
export type EventKind = 'scan' | 'sync' | 'pr' | 'analysis' | 'deploy' | 'policy' | 'system'

/** Repeats of the same message inside this window bump a counter instead of adding a row. */
const COALESCE_MS = 24 * 60 * 60 * 1000

export function logEvent(e: {
  level: EventLevel
  kind: EventKind
  message: string
  stack?: string
  service?: string
  detail?: string
}): void {
  const now = new Date()
  const db = getDb()

  // The same sentence, over and over, is one fact with a count -- not news each time. A
  // loop that reports "holding 13 updates" every poll cycle wrote 2,266 rows here and
  // buried everything that happened once.
  const recent = db
    .prepare(
      `SELECT id, count, COALESCE(last_at, at) AS seen_at FROM events
       WHERE kind = ? AND message = ? AND level = ?
         AND IFNULL(stack,'') = ? AND IFNULL(service,'') = ? AND IFNULL(detail,'') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(e.kind, e.message, e.level, e.stack ?? '', e.service ?? '', e.detail ?? '') as
    | { id: number; count: number; seen_at: string }
    | undefined

  if (recent && now.getTime() - Date.parse(recent.seen_at) < COALESCE_MS) {
    db.prepare(`UPDATE events SET count = count + 1, last_at = ? WHERE id = ?`).run(
      now.toISOString(),
      recent.id,
    )
  } else {
    db.prepare(
      `INSERT INTO events (at, level, kind, stack, service, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now.toISOString(),
      e.level,
      e.kind,
      e.stack ?? null,
      e.service ?? null,
      e.message,
      e.detail ?? null,
    )
  }
  const tag = `[${e.kind}]${e.stack ? ` ${e.stack}/${e.service ?? ''}` : ''}`
  const line = `${tag} ${e.message}${e.detail ? ` -- ${e.detail}` : ''}`
  if (e.level === 'error') console.error(line)
  else if (e.level === 'warn') console.warn(line)
  else console.log(line)
}
