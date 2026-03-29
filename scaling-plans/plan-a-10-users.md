# Plan A: 10 Users — Free, 1-2 Weekends

## Context

The AI: Sand to Agents app is a 1.29MB single-file HTML app on GitHub Pages. All data (107 concepts, 21 projects, 74 milestones, 411 hints) is embedded inline. State is in browser localStorage. Zero backend.

**Goal**: Let 10 friends/colleagues use the same curriculum with their own progress, cross-device sync, and optional leaderboard. Cost: $0/month.

---

## Recommendation: Keep static HTML + add optional Supabase sync

The current localStorage approach already works for independent users. The only gaps are: (1) cross-device sync, (2) data loss on browser clear, (3) social visibility. This plan adds the minimum backend to solve those three.

## Architecture

```
┌──────────────────────────────────┐
│  GitHub Pages (unchanged)        │
│  index.html (1.29MB)             │
│  - localStorage (primary store)  │
│  - Works fully offline           │
└──────────┬───────────────────────┘
           │ optional (lazy-loaded)
┌──────────▼───────────────────────┐
│  Supabase Free Tier              │
│  ├── Auth (GitHub OAuth)         │
│  ├── PostgreSQL                  │
│  │   └── user_state (JSONB)      │
│  └── Row Level Security          │
└──────────────────────────────────┘
```

## How It Works

1. App works exactly as today without signing in
2. Optional "Sign in with GitHub" button in header
3. On sign-in: localStorage state syncs to Supabase (debounced 5s)
4. On page load with auth: pull cloud state, merge with local
5. Leaderboard: simple query showing all users' progress

## Tech Stack

| Component | Choice | Cost |
|-----------|--------|------|
| Hosting | GitHub Pages (keep) | $0 |
| Auth | Supabase Auth (GitHub OAuth) | $0 |
| Database | Supabase PostgreSQL | $0 (free: 500MB, unlimited API) |
| Sync client | @supabase/supabase-js (CDN, ~45KB, lazy) | $0 |
| **Total** | | **$0/month** |

## Data Model

```sql
CREATE TABLE user_state (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE user_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own state" ON user_state
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE VIEW leaderboard AS
  SELECT
    u.raw_user_meta_data->>'avatar_url' AS avatar,
    u.raw_user_meta_data->>'user_name' AS name,
    jsonb_array_length(
      jsonb_path_query_array(us.state_json, '$.learned.keyvalue().key')
    ) AS concepts_learned,
    us.updated_at AS last_active
  FROM user_state us
  JOIN auth.users u ON u.id = us.user_id;
```

## Merge Strategy

State is additive-only (you learn, never unlearn), so conflict resolution is trivial:

```javascript
function mergeStates(local, cloud) {
  return {
    learned: { ...cloud.learned, ...local.learned },
    learnedAt: mergeMax(local.learnedAt, cloud.learnedAt),
    statuses: { ...cloud.statuses, ...local.statuses },
    milestones: { ...cloud.milestones, ...local.milestones },
    activeProject: local.activeProject || cloud.activeProject
  };
}
```

## Feature Roadmap

### MVP (Week 1-2)
- "Sign in with GitHub" button (optional, non-intrusive)
- Auto-sync localStorage ↔ Supabase on every save (debounced 5s)
- Merge on page load (cloud + local union)
- Works fully offline; syncs when online

### v2 (Week 3-4)
- Leaderboard panel showing all 10 users' progress
- Export/import state as JSON (manual backup)
- PWA manifest + service worker (installable on phone)

## Changes to index.html

~150 lines of JavaScript added:
1. Lazy-load Supabase client from CDN (`<script>` tag, only if user clicks Sign In)
2. Sign-in/sign-out UI in header (small button, non-intrusive)
3. `syncToCloud()` called in `saveState()` (debounced to prevent API spam)
4. `loadFromCloud()` called on page init when auth session exists
5. Leaderboard panel component (v2)

## Implementation Steps

1. Create Supabase project at supabase.com (5 minutes)
2. Create `user_state` table + RLS policy (copy SQL above)
3. Enable GitHub OAuth provider in Supabase Auth settings
4. Add ~150 lines to `index.html`:
   - CDN script tag for Supabase JS client
   - Auth button component
   - Sync/merge logic
   - Cloud load on init
5. Test: open on phone + laptop, mark a concept learned on one, verify it appears on the other
6. Push to GitHub → auto-deploys

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Supabase free tier removed | State always in localStorage too; can export as JSON anytime |
| Merge conflicts between devices | State is monotonic (additive only); union merge is always safe |
| Auth adds friction for new users | Auth is completely optional; app works exactly as before without it |
| Single-file HTML gets bigger | Supabase client is CDN-loaded (not inlined); HTML grows by ~150 lines only |

## Why This Approach Over Alternatives

- **No changes at all**: Works for single-device. But phone→laptop sync is a real need even for 10 users.
- **GitHub fork sync**: Too much friction. Nobody will commit JSON to a fork regularly.
- **Firebase**: Equivalent, but Supabase's PostgreSQL is more portable and free tier is more generous.
- **Cloudflare Workers KV**: Requires writing auth + sync Worker from scratch. More moving parts.
- **PWA only**: Solves installability but not cross-device sync. Good as an add-on (v2), not primary.
