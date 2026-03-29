# Plan B: 1 Million Users — Full Platform

## Vision: "Duolingo for AI Engineering"

A structured learning platform where anyone can sign up, follow the semiconductor-to-agents curriculum, track progress, get personalized recommendations, and engage with a community.

**Target**: 1M registered, ~100K MAU, ~10K DAU at steady state.

---

## Architecture

```
                          EDGE LAYER
┌──────────────────────────────────────────────────┐
│  Cloudflare (CDN + DNS + DDoS protection)        │
│  - Static assets cached at 300+ PoPs globally    │
│  - Edge rate limiting                            │
└───────────────────┬──────────────────────────────┘
                    │
              APPLICATION LAYER
┌───────────────────▼──────────────────────────────┐
│  Vercel (Next.js 15 App Router)                  │
│                                                  │
│  ┌─────────────┐  ┌───────────────────────────┐  │
│  │ SSG Content  │  │ tRPC API Routes           │  │
│  │ - 107 concept│  │ - User progress CRUD      │  │
│  │   pages      │  │ - Leaderboard queries     │  │
│  │ - 21 project │  │ - Spaced repetition       │  │
│  │   pages      │  │ - AI Q&A (premium)        │  │
│  │ (pre-built)  │  │ - Analytics events        │  │
│  └─────────────┘  └───────────────────────────┘  │
│                                                  │
│  ┌───────────────────────────────────────────┐   │
│  │ Edge Middleware                            │   │
│  │ - Clerk auth session validation           │   │
│  │ - A/B test assignment                     │   │
│  │ - Geographic routing                      │   │
│  └───────────────────────────────────────────┘   │
└──────────┬──────────────────┬────────────────────┘
           │                  │
     DATA LAYER         SERVICES LAYER
┌──────────▼────────┐  ┌─────▼─────────────────────┐
│ Neon PostgreSQL    │  │ Clerk (Auth)              │
│ (serverless)       │  │ - Email + social login    │
│                    │  │ - User mgmt dashboard     │
│ Tables:            │  │ - Organization support    │
│ ├── users          │  ├───────────────────────────┤
│ ├── concepts       │  │ Upstash Redis             │
│ ├── projects       │  │ - Leaderboard (ZSET)      │
│ ├── milestones     │  │ - Session cache           │
│ ├── hints          │  │ - Rate limiting           │
│ ├── user_progress  │  │ - Streak tracking         │
│ ├── user_projects  │  ├───────────────────────────┤
│ ├── cohorts        │  │ Typesense (Search)        │
│ ├── discussions    │  │ - Full-text concepts      │
│ ├── events         │  │ - Typo-tolerant queries   │
│ └── subscriptions  │  ├───────────────────────────┤
└────────────────────┘  │ Anthropic Claude API      │
                        │ - AI Q&A per concept      │
┌────────────────────┐  │ - Adaptive quiz gen       │
│ Cloudflare R2      │  ├───────────────────────────┤
│ - Pre-rendered SVG │  │ Tinybird (Analytics)      │
│   diagrams         │  │ - Real-time event ingest  │
│ - User avatars     │  │ - Drop-off dashboards     │
│ - PDF certificates │  │ - Content quality metrics │
└────────────────────┘  └───────────────────────────┘
```

## Tech Stack with Reasoning

### Frontend

| Choice | Technology | Why |
|--------|-----------|-----|
| Framework | **Next.js 15** (App Router) | Server Components for zero-JS content pages; ISR for dynamic; best Vercel integration; dominant React ecosystem |
| Rendering | **SSG** for content, **ISR** (60s) for dashboards | 107 concept pages + 21 project pages pre-built at deploy. User-specific pages (dashboard, leaderboard) use ISR or client fetch |
| State | **TanStack Query** + **Zustand** | Server state (progress) via React Query with optimistic updates. Client state (UI prefs) via Zustand. No Redux overhead |
| Styling | **Tailwind CSS** + **Radix Primitives** | Preserve current warm design language. Radix for accessible dialog, dropdown, tooltip |
| Diagrams | **Pre-rendered SVGs** at build time | Eliminate 800KB of client JS (Mermaid, Rough.js, KaTeX). Single biggest perf win |
| Mobile | **PWA first**, React Native later | PWA gets 80% of native feel at 5% of cost. Build native only if MAU >500K justifies it |

### Backend

| Choice | Technology | Why |
|--------|-----------|-----|
| API | **tRPC** | End-to-end type safety with Next.js; no schema duplication; lighter than GraphQL for single-client |
| Auth | **Clerk** | Best Next.js DX; social login; user management dashboard; org support for cohorts; 10K MAU free |
| Database | **Neon PostgreSQL** (serverless) | Scales to zero; branches for preview deploys; standard Postgres (JSONB, full-text, window functions) |
| Cache | **Upstash Redis** (serverless) | Leaderboard ZSET (O(log N)); session cache; rate limiting; streak counter; pay-per-request |
| Search | **Typesense** | Typo-tolerant; open source; cheaper than Algolia; can self-host on Fly.io |
| Storage | **Cloudflare R2** | S3-compatible; zero egress fees; diagrams, avatars, certificates |
| Analytics | **Tinybird** | Real-time event ingestion; SQL-based dashboards; free tier generous |
| Monitoring | **Vercel Analytics** + **Sentry** | Web Vitals + error tracking |

## Data Model

```sql
-- ═══ CONTENT (versioned, editable without redeploy) ═══
CREATE TABLE concepts (
  id          TEXT PRIMARY KEY,     -- 'matrix-multiplication'
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  content     TEXT NOT NULL,        -- MDX or HTML
  phase       INT NOT NULL,
  category    TEXT NOT NULL,
  difficulty  INT DEFAULT 1,        -- 1-5
  order_idx   INT NOT NULL,
  version     INT DEFAULT 1,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  elevator    TEXT,
  phase       INT NOT NULL,
  order_idx   INT NOT NULL,
  version     INT DEFAULT 1
);

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id),
  title       TEXT NOT NULL,
  description TEXT,
  acceptance  JSONB,
  order_idx   INT NOT NULL
);

CREATE TABLE hints (
  id           TEXT PRIMARY KEY,
  milestone_id TEXT REFERENCES milestones(id),
  step_title   TEXT NOT NULL,
  detail       TEXT NOT NULL,
  code         TEXT,
  pitfall      TEXT,
  order_idx    INT NOT NULL
);

-- ═══ USERS & PROGRESS ═══
CREATE TABLE users (
  id             TEXT PRIMARY KEY,   -- Clerk user ID
  email          TEXT UNIQUE NOT NULL,
  display_name   TEXT NOT NULL,
  avatar_url     TEXT,
  tier           TEXT DEFAULT 'free', -- 'free' | 'premium'
  streak_current INT DEFAULT 0,
  streak_longest INT DEFAULT 0,
  streak_last    DATE,
  created_at     TIMESTAMPTZ DEFAULT now(),
  last_active_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_progress (
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  concept_id     TEXT REFERENCES concepts(id),
  learned_at     TIMESTAMPTZ DEFAULT now(),
  confidence     INT DEFAULT 1,      -- 1-5 for spaced repetition
  next_review_at TIMESTAMPTZ,
  review_count   INT DEFAULT 0,
  PRIMARY KEY (user_id, concept_id)
);

CREATE TABLE user_project_status (
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES projects(id),
  status       TEXT DEFAULT 'not_started',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE user_milestone_status (
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id),
  completed    BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, milestone_id)
);

-- ═══ SOCIAL ═══
CREATE TABLE cohorts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  invite_code TEXT UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE cohort_members (
  cohort_id TEXT REFERENCES cohorts(id) ON DELETE CASCADE,
  user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (cohort_id, user_id)
);

CREATE TABLE discussion_posts (
  id         SERIAL PRIMARY KEY,
  concept_id TEXT REFERENCES concepts(id),
  user_id    TEXT REFERENCES users(id),
  body       TEXT NOT NULL,
  parent_id  INT REFERENCES discussion_posts(id),
  upvotes    INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══ ANALYTICS ═══
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT,
  event_type TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══ MATERIALIZED VIEWS ═══
CREATE MATERIALIZED VIEW leaderboard AS
  SELECT
    u.id, u.display_name, u.avatar_url, u.streak_current,
    COUNT(up.concept_id) AS concepts_learned,
    COUNT(DISTINCT ups.project_id) FILTER (WHERE ups.status = 'done') AS projects_completed,
    u.last_active_at
  FROM users u
  LEFT JOIN user_progress up ON u.id = up.user_id
  LEFT JOIN user_project_status ups ON u.id = ups.user_id
  GROUP BY u.id;

-- ═══ INDEXES ═══
CREATE INDEX idx_progress_user ON user_progress(user_id);
CREATE INDEX idx_progress_review ON user_progress(next_review_at) WHERE next_review_at IS NOT NULL;
CREATE INDEX idx_events_type ON events(event_type, created_at);
CREATE INDEX idx_discussion_concept ON discussion_posts(concept_id, created_at);
```

## Feature Roadmap

### Phase 1: MVP (Months 1-2)
- User accounts (email + GitHub + Google via Clerk)
- All content migrated from inline JS to Neon database
- Dashboard with progress tracking (same UX as current)
- Cross-device sync (real-time via React Query invalidation)
- SSG concept and project pages
- Build guides with expandable hints
- Mobile-responsive (refine current CSS)
- Deploy to Vercel

### Phase 2: Engagement (Months 3-4)
- Spaced repetition for concept review (SM-2 algorithm)
- Daily streak tracking with visual calendar
- Global leaderboard (concepts, projects, streaks)
- Cohort system (study groups with invite codes)
- Full-text concept search (Typesense)
- Discussion threads per concept
- Badges/achievements (first concept, 7-day streak, phase complete, etc.)

### Phase 3: Intelligence (Months 5-7)
- AI Q&A per concept (Claude API, grounded in concept content)
- Adaptive difficulty (quiz → high score → skip concept)
- Personalized "next up" based on learning graph topology
- Content CMS (edit concepts without redeploying)
- A/B testing framework for learning path order
- Analytics dashboard (completion rates, drop-off points, hardest concepts)

### Phase 4: Monetization & Scale (Months 8-12)
- Premium tier ($9/month): AI Q&A, advanced hints, certificates
- Progress certificates (shareable PDF/images)
- Instructor dashboard (assign curriculum to cohort, track group progress)
- Public API for integrations (Slack bot, Discord bot)
- React Native mobile apps (if MAU justifies)
- Multi-language UI (i18n; content starts English-only)
- Enterprise SSO for corporate training programs

## Cost at Scale

| Component | 1K users | 10K users | 100K users | 1M users |
|-----------|----------|-----------|------------|----------|
| Vercel Pro | $20 | $20 | $150 | $500 |
| Neon PostgreSQL | $0 | $19 | $69 | $300 |
| Clerk Auth | $0 | $25 | $100 | $500 |
| Upstash Redis | $0 | $10 | $30 | $120 |
| Typesense | $0 | $0 | $30 | $100 |
| Cloudflare R2 | $0 | $5 | $15 | $50 |
| Tinybird Analytics | $0 | $0 | $50 | $200 |
| AI API (Claude) | $0 | $50 | $300 | $2,000 |
| Sentry | $0 | $26 | $80 | $200 |
| **Total/month** | **$20** | **$155** | **$825** | **$3,970** |

### Revenue Model
- 2% premium conversion at 1M users = 20,000 × $9/mo = **$180,000/mo revenue**
- Infrastructure cost: **$3,970/mo**
- **Gross margin: 97.8%**

## Migration Path from Current State

```
Current (Static)          Phase 1 (Months 1-2)
┌──────────────────┐      ┌──────────────────────┐
│ 1.29MB HTML      │      │ Next.js 15           │
│ localStorage     │ ──→  │ Neon DB (content)    │
│ GitHub Pages     │      │ Clerk auth           │
│ 1 user           │      │ tRPC progress API    │
└──────────────────┘      │ SSG content pages    │
                          │ Vercel deploy        │
Content extraction:       └──────────────────────┘
- Parse CONCEPTS, PHASES,
  BUILD_GUIDES from JS    Phase 2-4 (Months 3-12)
- Seed Neon database      ┌──────────────────────┐
- Port CSS → Tailwind     │ + Spaced rep, streaks│
- Port JS → React         │ + Leaderboard, search│
                          │ + AI Q&A, adaptive   │
                          │ + Premium, certs     │
                          │ + Mobile apps        │
                          └──────────────────────┘
```

### Step-by-Step Migration

1. **Extract content** → Python script parses inline JS objects from index.html → JSON → seed Neon tables
2. **Create Next.js project** → Port UI to React components with Tailwind (preserve the warm design)
3. **Add Clerk auth** → Sign up/sign in, user profile
4. **Implement tRPC routes** → Progress CRUD, dashboard data
5. **Pre-render diagrams** → Run mermaid-cli + rough-to-svg at build time → ship static SVGs
6. **Deploy to Vercel** → Connect GitHub repo, auto-deploy on push
7. **Redirect old URL** → GitHub Pages → Vercel domain

## Key Architecture Decisions

1. **Next.js over Astro**: Astro excels at static content but struggles with interactive features (dashboards, leaderboards, AI chat). Next.js handles both SSG content and dynamic interactivity.

2. **Neon over Supabase (at scale)**: Best-of-breed components (Clerk + Neon + R2) give better control, pricing, and migration options than Supabase's bundled approach. Neon's serverless auto-scaling is critical for variable traffic.

3. **tRPC over GraphQL**: Single-client app. tRPC gives full type safety with zero schema overhead. GraphQL's multi-client flexibility adds complexity we don't need.

4. **Pre-rendered diagrams**: Biggest single performance win. Current app loads 800KB of client JS (Mermaid, Rough.js, Chart.js, KaTeX). Pre-rendering to SVG at build time eliminates all of it. First load drops from 1.29MB to ~400KB.

5. **Clerk over NextAuth**: Better DX, built-in user management dashboard, organization support for cohorts/teams, webhook integrations. Free tier covers 10K MAU.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Premature complexity — building for 1M before having 100 users | High | Follow phases strictly. Phase 1 is a 2-month MVP. Don't build Phase 2+ until user numbers justify it |
| AI Q&A cost explosion if feature is popular | High | Rate limit free tier (5 questions/day); cache common questions; premium-gate heavy usage; use cheaper models for simple queries |
| Vendor lock-in (Vercel + Clerk + Neon) | Medium | Use standard Next.js APIs (runs on any Node host); Clerk replaceable by NextAuth; Neon is standard PostgreSQL |
| Content staleness as AI field moves | Medium | Implement auto-update system (see auto-update-design.md) |
| Scope creep into social features | High | Social amplifies the curriculum; it doesn't replace it. Core value is learning content. Keep social minimal |
| SEO competition for "learn AI" keywords | Medium | SSG gives perfect Lighthouse scores. Add JSON-LD structured data. Blog with learning insights |
| Migration data loss from current users | Low | Add export/import JSON to current app before migration. New app offers "restore from backup" on first login |
